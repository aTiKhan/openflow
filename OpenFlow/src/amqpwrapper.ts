import * as retry from "async-retry";
import * as amqplib from "amqplib";
import { Config } from "./Config";
import { Crypt } from "./Crypt";
import * as url from "url";
import { NoderedUtil } from "@openiap/openflow-api";
import { WebSocketServer } from "./WebSocketServer";
import { Span } from "@opentelemetry/api";
import { Logger } from "./Logger";
import events = require("events");
const got = require("got");
type QueueOnMessage = (msg: string, options: QueueMessageOptions, ack: any, done: any) => void;
interface IHashTable<T> {
    [key: string]: T;
}
export type QueueMessageOptions = {
    correlationId: string,
    replyTo: string,
    consumerTag: string,
    routingkey: string,
    exchange: string
}
type AssertQueue = {
    consumerCount: number;
    messageCount: number;
    queue: string;
}
export class Deferred<T> {
    promise: Promise<T>;
    reject: any;
    resolve: any;
    constructor() {
        const me: Deferred<T> = this;
        this.promise = new Promise<T>((resolve, reject) => {
            me.reject = reject;
            me.resolve = resolve;
        });
    }
}
export class amqpqueue {
    public queue: string;
    public queuename: string;
    public callback: QueueOnMessage;
    public ok: AssertQueue;
    public QueueOptions: any;
    public consumerTag: string;
}
export class amqpexchange {
    public exchange: string;
    public algorithm: string;
    public routingkey: string;
    public queue: amqpqueue;
    public callback: QueueOnMessage;
    public ok: amqplib.Replies.AssertExchange;
    public ExchangeOptions: any;
}
export declare interface amqpwrapper {
    on(event: 'connected', listener: () => void): this;
    on(event: 'disconnected', listener: () => void): this;
    on(event: string, listener: Function): this;
}
// tslint:disable-next-line: class-name
export class amqpwrapper extends events.EventEmitter {
    private conn: amqplib.Connection;
    private channel: amqplib.ConfirmChannel; // amqplib.Channel  channel: amqplib.ConfirmChannel;
    // private confirmchannel: amqplib.ConfirmChannel; // channel: amqplib.ConfirmChannel;
    private connectionstring: string;
    public AssertExchangeOptions: any = { durable: false, confirm: true };
    public AssertQueueOptions: amqplib.any = { durable: true };
    private activecalls: IHashTable<Deferred<string>> = {};
    // private queues: IHashTable<Deferred<string>> = {};
    // public queues: IHashTable<amqpqueue> = {};
    // private exchanges: IHashTable<amqpexchange> = {};
    private queues: amqpqueue[] = [];
    private exchanges: amqpexchange[] = [];
    private replyqueue: amqpqueue;
    private static _instance: amqpwrapper = null;
    public static Instance(): amqpwrapper {
        return this._instance;
    }
    public static SetInstance(instance: amqpwrapper): void {
        this._instance = instance;
    }
    constructor(connectionstring: string) {
        super();
        this.connectionstring = connectionstring;
        if (!NoderedUtil.IsNullEmpty(Config.amqp_dlx)) {
            this.AssertQueueOptions.arguments = {};
            this.AssertQueueOptions.arguments['x-dead-letter-exchange'] = Config.amqp_dlx;
        }
    }
    private timeout: NodeJS.Timeout = null;
    public queuemessagecounter: object = {};
    public incqueuemessagecounter(queuename: string): number {
        let result: number = 0;
        if (!NoderedUtil.IsNullUndefinded(this.queuemessagecounter[queuename])) result = this.queuemessagecounter[queuename];
        result++;
        this.queuemessagecounter[queuename] = result;
        return result;
    }

    async connect(): Promise<void> {
        try {
            if (this.timeout != null) {
                clearTimeout(this.timeout);
                this.timeout = null;
            }
            if (this.conn == null) {
                this.conn = await amqplib.connect(this.connectionstring);
                this.conn.on('error', (error) => {
                    if (error.code != 404) {
                        Logger.instanse.error(error);
                    }
                });
                this.conn.on("close", () => {
                    Logger.instanse.info("[AMQP] reconnecting");
                    this.conn = null;
                    if (this.timeout != null) {
                        clearTimeout(this.timeout);
                        this.timeout = null;
                    }
                    this.timeout = setTimeout(this.connect.bind(this), 1000);
                    this.emit("disconnected");
                });
            }
            await this.AddReplyQueue();
            this.channel.on('error', (error) => {
                if (error.code != 404) {
                    Logger.instanse.error(error);
                }
            });
            this.emit("connected");
        } catch (error) {
            console.error(error);
            if (this.timeout != null) {
                clearTimeout(this.timeout);
                this.timeout = null;
            }
            this.timeout = setTimeout(this.connect.bind(this), 1000);
        }
    }
    async AddReplyQueue(): Promise<void> {
        try {
            console.log("AddReplyQueue begin");
            this.channel = await this.conn.createConfirmChannel();
            this.replyqueue = await this.AddQueueConsumer("", null, null, (msg: any, options: QueueMessageOptions, ack: any, done: any) => {
                if (this.replyqueue) {
                    if (!NoderedUtil.IsNullUndefinded(WebSocketServer.websocket_queue_message_count)) WebSocketServer.websocket_queue_message_count.
                        bind({ ...Logger.otel.defaultlabels, queuename: this.replyqueue.queue }).update(this.incqueuemessagecounter(this.replyqueue.queue));
                    if (!NoderedUtil.IsNullUndefinded(this.activecalls[options.correlationId])) {
                        this.activecalls[options.correlationId].resolve(msg);
                        this.activecalls[options.correlationId] = null;
                        delete this.activecalls[options.correlationId];
                    }
                }
                ack();
                done();
            }, undefined);
            // We don't want to recreate this
            this.queues = this.queues.filter(q => q.consumerTag != this.replyqueue.consumerTag);
            this.channel.on('return', async (e1) => {
                try {
                    let msg = e1.content.toString();
                    let exchange: string = "";
                    let routingKey: string = "";
                    let replyTo: string = "";
                    let correlationId: string = "";
                    let errormsg: string = "Send timeout";
                    if (e1.fields && e1.fields.replyText) errormsg = e1.fields.replyText;
                    if (e1.fields && e1.fields.exchange) exchange = e1.fields.exchange;
                    if (e1.fields && e1.fields.routingKey) routingKey = e1.fields.routingKey;
                    if (e1.properties && e1.properties.replyTo) replyTo = e1.properties.replyTo;
                    if (e1.properties && e1.properties.correlationId) correlationId = e1.properties.correlationId;

                    if (typeof msg === "string" || msg instanceof String) {
                        try {
                            msg = JSON.parse((msg as any));
                        } catch (error) {
                        }
                    }
                    if (!NoderedUtil.IsNullEmpty(replyTo)) {
                        msg.command = "timeout";
                        Logger.instanse.info("[AMQP][" + routingKey + "] notify " + replyTo + " " + errormsg + " to " + routingKey)
                        await amqpwrapper.Instance().send("", replyTo, msg, 20000, correlationId, "");
                    }
                } catch (error) {
                }
            })
            this.channel.on('close', () => {
                try {
                    if (this.conn != null) this.conn.close();
                } catch (error) {
                }
                this.channel = null;
                if (this.timeout != null) {
                    clearTimeout(this.timeout);
                    this.timeout = null;
                }
                this.timeout = setTimeout(this.connect.bind(this), 1000);
            });

            console.log("AddReplyQueue complete");
        } catch (error) {
            console.error(error);
        }
    }
    async RemoveQueueConsumer(queue: amqpqueue, parent: Span): Promise<void> {
        const span: Span = Logger.otel.startSubSpan("amqpwrapper.validateToken", parent);
        try {
            if (queue != null) {
                Logger.instanse.info("[AMQP] Remove queue consumer " + queue.queue + "/" + queue.consumerTag);
                var exc = this.exchanges.filter(x => x.queue.consumerTag == queue.consumerTag);
                if (exc.length > 0) {
                    try {
                        this.channel.unbindQueue(exc[0].queue.queue, exc[0].exchange, exc[0].routingkey);
                    } catch (error) {
                        Logger.instanse.error(error);
                    }
                }
                //this.exchanges.push(q);
                if (this.channel != null) await this.channel.cancel(queue.consumerTag);
                this.queues = this.queues.filter(q => q.consumerTag != queue.consumerTag);
            }
        } catch (error) {
            span.recordException(error);
            throw error;
        } finally {
            Logger.otel.endSpan(span);
        }
    }
    async AddQueueConsumer(queuename: string, QueueOptions: any, jwt: string, callback: QueueOnMessage, parent: Span): Promise<amqpqueue> {
        const span: Span = Logger.otel.startSubSpan("amqpwrapper.validateToken", parent);
        try {
            if (this.channel == null || this.conn == null) throw new Error("Cannot Add new Queue Consumer, not connected to rabbitmq");
            let queue: string = (NoderedUtil.IsNullEmpty(queuename) ? "" : queuename);
            if (Config.amqp_force_queue_prefix && !NoderedUtil.IsNullEmpty(jwt) && !NoderedUtil.IsNullEmpty(queue)) {
                // assume queue names if 24 letters is an mongodb is, should proberly do a real test here
                if (queue.length == 24) {
                    const tuser = Crypt.verityToken(jwt);
                    let name = tuser.username.split("@").join("").split(".").join("");
                    name = name.toLowerCase();
                    let skip: boolean = false;
                    if (tuser._id == queue) {
                        // Queue is for me
                        skip = false;
                    } else if (tuser.roles != null) {
                        // Queue is for a group i am a member of.
                        const isrole = tuser.roles.filter(x => x._id == queue);
                        if (isrole.length > 0) skip = false;
                    }
                    if (skip) {
                        // Do i have permission to listen on a queue with this id ?
                        const arr = await Config.db.query({ _id: queue }, { name: 1 }, 1, 0, null, "users", jwt, undefined, undefined, span);
                        if (arr.length == 0) skip = true;
                        if (!skip) {
                            const arr = await Config.db.query({ _id: queue }, { name: 1 }, 1, 0, null, "openrpa", jwt, undefined, undefined, span);
                            if (arr.length == 0) skip = true;
                        }
                        if (!skip) {
                            const arr = await Config.db.query({ _id: queue }, { name: 1 }, 1, 0, null, "workflow", jwt, undefined, undefined, span);
                            if (arr.length == 0) skip = true;
                        }
                        if (!skip) {
                            queue = name + queue;
                            if (queue.length == 24) { queue += "1"; }
                        } else {
                            Logger.instanse.info("[SKIP] skipped force prefix for " + queue);
                        }
                    } else {
                        Logger.instanse.info("[SKIP] skipped force prefix for " + queue);
                    }
                } else {
                    const tuser = Crypt.verityToken(jwt);
                    let name = tuser.username.split("@").join("").split(".").join("");
                    name = name.toLowerCase();
                    queue = name + queue;
                    if (queue.length == 24) { queue += "1"; }
                }
            } else if (queue.length == 24) {
                if (NoderedUtil.IsNullEmpty(jwt)) {
                    const tuser = Crypt.verityToken(jwt);

                    const isrole = tuser.roles.filter(x => x._id == queue);
                    if (isrole.length == 0 && tuser._id != queue) {
                        let skip: boolean = false;
                        const arr = await Config.db.query({ _id: queue }, { name: 1 }, 1, 0, null, "users", jwt, undefined, undefined, span);
                        if (arr.length == 0) skip = true;
                        if (!skip) {
                            const arr = await Config.db.query({ _id: queue }, { name: 1 }, 1, 0, null, "openrpa", jwt, undefined, undefined, span);
                            if (arr.length == 0) skip = true;
                        }
                        if (!skip) {
                            const arr = await Config.db.query({ _id: queue }, { name: 1 }, 1, 0, null, "workflow", jwt, undefined, undefined, span);
                            if (arr.length == 0) skip = true;
                        }
                        if (!skip) {
                            throw new Error("Access denied creating consumer for " + queue);
                        }
                    }

                }
            }
            const q: amqpqueue = new amqpqueue();
            q.callback = callback;
            q.QueueOptions = Object.assign({}, (QueueOptions != null ? QueueOptions : this.AssertQueueOptions));
            if (NoderedUtil.IsNullEmpty(queue)) queue = "";
            if (queue.startsWith("amq.")) queue = "";
            // if (NoderedUtil.IsNullEmpty(queue)) q.QueueOptions.autoDelete = true;
            if (NoderedUtil.IsNullEmpty(queue)) q.QueueOptions.exclusive = true;
            // if (NoderedUtil.IsNullEmpty(queue)) q.QueueOptions.autoDelete = true;
            q.ok = await this.channel.assertQueue(queue, q.QueueOptions);
            if (q && q.ok) {
                this.queues.push(q);
                q.queue = q.ok.queue;
                q.queuename = queuename;
                const consumeresult = await this.channel.consume(q.ok.queue, (msg) => {
                    this.OnMessage(q, msg, q.callback);
                }, { noAck: false });
                q.consumerTag = consumeresult.consumerTag;
                Logger.instanse.info("[AMQP] Added queue consumer " + q.queue + "/" + q.consumerTag);
            } else {
                throw new Error("Failed asserting Queue " + queue);
            }
            return q;
        } catch (error) {
            span.recordException(error);
            throw error;
        } finally {
            Logger.otel.endSpan(span);
        }
    }
    async AddExchangeConsumer(exchange: string, algorithm: string, routingkey: string, ExchangeOptions: any, jwt: string, callback: QueueOnMessage, parent: Span): Promise<amqpexchange> {
        const span: Span = Logger.otel.startSubSpan("amqpwrapper.validateToken", parent);
        try {
            if (NoderedUtil.IsNullEmpty(exchange)) throw new Error("exchange name cannot be empty");
            if (this.channel == null || this.conn == null) throw new Error("Cannot Add new Exchange Consumer, not connected to rabbitmq");
            if (Config.amqp_force_exchange_prefix && !NoderedUtil.IsNullEmpty(jwt)) {
                const tuser = Crypt.verityToken(jwt);
                let name = tuser.username.split("@").join("").split(".").join("");
                name = name.toLowerCase();
                exchange = name + exchange;
                if (exchange.length == 24) { exchange += "1"; }
            }
            const q: amqpexchange = new amqpexchange();
            if (!NoderedUtil.IsNullEmpty(q.queue)) {
                this.RemoveQueueConsumer(q.queue, span);
            }
            // q.ExchangeOptions = new Object((ExchangeOptions != null ? ExchangeOptions : this.AssertExchangeOptions));
            q.ExchangeOptions = Object.assign({}, (ExchangeOptions != null ? ExchangeOptions : this.AssertExchangeOptions));
            if (exchange != Config.amqp_dlx) q.ExchangeOptions.autoDelete = true;
            q.exchange = exchange; q.algorithm = algorithm; q.routingkey = routingkey; q.callback = callback;
            const _ok = await this.channel.assertExchange(q.exchange, q.algorithm, q.ExchangeOptions);
            let AssertQueueOptions = null;
            if (!NoderedUtil.IsNullEmpty(Config.amqp_dlx) && exchange == Config.amqp_dlx) {
                AssertQueueOptions = Object.create(this.AssertQueueOptions);
                delete AssertQueueOptions.arguments;
            }
            q.queue = await this.AddQueueConsumer("", AssertQueueOptions, jwt, q.callback, span);
            if (q.queue) {
                this.channel.bindQueue(q.queue.queue, q.exchange, q.routingkey);
                Logger.instanse.info("[AMQP] Added exchange consumer " + q.exchange + ' to queue ' + q.queue.queue);
            }
            this.exchanges.push(q);
            return q;
        } catch (error) {
            span.recordException(error);
            throw error;
        } finally {
            Logger.otel.endSpan(span);
        }
    }
    OnMessage(sender: amqpqueue, msg: amqplib.ConsumeMessage, callback: QueueOnMessage): void {
        // Logger.instanse.info("OnMessage " + msg.content.toString());
        try {
            const now = new Date();
            // const seconds = (now.getTime() - sender.cli.lastheartbeat.getTime()) / 1000;
            // if (seconds >= Config.client_heartbeat_timeout) {
            //     try {
            //         Logger.instanse.info("amqpwrapper.OnMessage: receive message for inactive client, nack message and try and close");
            //         this.channel.nack(msg);
            //         sender.cli.Close();
            //     } catch (error) {
            //         console.error(error);
            //     }
            //     return;
            // }
            if (msg == null) {
                return;
            }

            const correlationId: string = msg.properties.correlationId;
            const replyTo: string = msg.properties.replyTo;
            const consumerTag: string = msg.fields.consumerTag;
            const routingkey: string = msg.fields.routingkey;
            const exchange: string = msg.fields.exchange;
            const options: QueueMessageOptions = {
                correlationId: correlationId,
                replyTo: replyTo,
                consumerTag: consumerTag,
                routingkey: routingkey,
                exchange: exchange
            }
            const data: string = msg.content.toString();
            callback(data, options, (nack: boolean) => {
                try {
                    if (nack == false) {
                        this.channel.nack(msg);
                        // this.channel.nack(msg, false, true);
                        msg = null;
                        return;
                    }
                    this.channel.ack(msg);
                } catch (error) {
                    console.error(error);
                }
            }, (result) => {
                // ROLLBACK
                // if (msg != null && !NoderedUtil.IsNullEmpty(replyTo)) {
                //     try {
                //         this.channel.sendToQueue(replyTo, Buffer.from(result), { correlationId: msg.properties.correlationId });
                //     } catch (error) {
                //         console.error("Error sending response to " + replyTo + " " + JSON.stringify(error))
                //     }
                // }
            });
        } catch (error) {
            console.error(error);
        }
    }
    async sendWithReply(exchange: string, queue: string, data: any, expiration: number, correlationId: string, routingkey: string): Promise<string> {
        if (NoderedUtil.IsNullEmpty(correlationId)) correlationId = NoderedUtil.GetUniqueIdentifier();
        this.activecalls[correlationId] = new Deferred();
        if (this.replyqueue) {
            await this.sendWithReplyTo(exchange, queue, this.replyqueue.queue, data, expiration, correlationId, routingkey);
        }
        return this.activecalls[correlationId].promise;
    }
    async sendWithReplyTo(exchange: string, queue: string, replyTo: string, data: any, expiration: number, correlationId: string, routingkey: string): Promise<void> {
        if (this.channel == null || this.conn == null) {
            throw new Error("Cannot send message, when not connected");
        }
        if (typeof data !== 'string' && !(data instanceof String)) {
            data = JSON.stringify(data);
        }
        Logger.instanse.info("send to queue: " + queue + " exchange: " + exchange + " with reply to " + replyTo + " correlationId: " + correlationId);
        const options: any = { mandatory: true };
        options.replyTo = replyTo;
        if (NoderedUtil.IsNullEmpty(correlationId)) correlationId = NoderedUtil.GetUniqueIdentifier();
        if (!NoderedUtil.IsNullEmpty(correlationId)) options.correlationId = correlationId;
        if (expiration < 1) expiration = Config.amqp_default_expiration;
        options.expiration = expiration.toString();
        options.mandatory = true;
        // options.confirm = true;
        // options.persistent = true;
        // options.durable = true;
        // options.mandatory = true;
        // options.immediate = true;
        if (NoderedUtil.IsNullEmpty(exchange)) {
            this.channel.publish("", queue, Buffer.from(data), options);

            await this.channel.waitForConfirms();

            // if (!await this.checkQueue(queue)) {
            //     throw new Error("No consumer listening at " + queue);
            // }
            // if (!this.channel.sendToQueue(queue, Buffer.from(data), options, (err, ok) => {
            // })) {
            //     throw new Error("No consumer listening at " + queue);
            // }
            if (!NoderedUtil.IsNullUndefinded(WebSocketServer.websocket_queue_message_count)) WebSocketServer.websocket_queue_message_count.
                bind({ ...Logger.otel.defaultlabels, queuename: queue }).update(this.incqueuemessagecounter(queue));
        } else {
            this.channel.publish(exchange, routingkey, Buffer.from(data), options);
        }
    }
    async send(exchange: string, queue: string, data: any, expiration: number, correlationId: string, routingkey: string): Promise<void> {
        if (this.channel == null || this.conn == null) {
            throw new Error("Cannot send message, when not connected");
        }
        if (typeof data !== 'string' && !(data instanceof String)) {
            data = JSON.stringify(data);
        }
        if (NoderedUtil.IsNullEmpty(correlationId)) correlationId = NoderedUtil.GetUniqueIdentifier();
        Logger.instanse.info("send to queue: " + queue + " exchange: " + exchange);
        const options: any = { mandatory: true };
        if (!NoderedUtil.IsNullEmpty(correlationId)) options.correlationId = correlationId;
        if (expiration < 1) expiration = Config.amqp_default_expiration;
        options.expiration = expiration.toString();
        options.mandatory = true;
        // options.confirm = true;
        // options.persistent = true;
        // options.durable = true;
        // options.mandatory = true;
        // options.immediate = true;
        if (NoderedUtil.IsNullEmpty(exchange)) {
            this.channel.publish("", queue, Buffer.from(data), options);
            await this.channel.waitForConfirms();

            // if (!await this.checkQueue(queue)) {
            //     throw new Error("No consumer listening at " + queue);
            // }
            // if (!this.channel.sendToQueue(queue, Buffer.from(data), options, (err, ok) => {
            // })) {
            //     throw new Error("No consumer listening at " + queue);
            // }
            if (!NoderedUtil.IsNullUndefinded(WebSocketServer.websocket_queue_message_count)) WebSocketServer.websocket_queue_message_count.
                bind({ ...Logger.otel.defaultlabels, queuename: queue }).update(this.incqueuemessagecounter(queue));
        } else {
            this.channel.publish(exchange, routingkey, Buffer.from(data), options);
        }
    }
    static parseurl(amqp_url): url.UrlWithParsedQuery {
        const q = url.parse(amqp_url, true);
        if (q.port == null || q.port == "") { q.port = "15672"; }
        if (q.auth != null && q.auth != "") {
            const arr = q.auth.split(':');
            (q as any).username = arr[0];
            (q as any).password = arr[1];
        } else {
            (q as any).username = Config.amqp_username;
            (q as any).password = Config.amqp_password;
        }
        q.protocol = 'http://';
        return q;
    }

    // This will crash the channel, that does not seem scalable
    async checkQueue(queuename: string): Promise<boolean> {
        if (Config.amqp_check_for_consumer) {
            let test: AssertQueue = null;
            try {
                if (Config.amqp_check_for_consumer_count) {
                    return this.checkQueueConsumerCount(queuename);
                }
                test = await amqpwrapper.getqueue(Config.amqp_url, '/', queuename);
                if (test == null) {
                    return false;
                }
            } catch (error) {
                test = null;
            }
            if (test == null || test.consumerCount == 0) {
                return false;
            }
        }
        return true;
    }
    async checkQueueConsumerCount(queuename: string): Promise<boolean> {
        let result: boolean = false;
        try {
            result = await retry(async bail => {
                const queue = await amqpwrapper.getqueue(Config.amqp_url, '/', queuename);
                // const queue = await amqpwrapper.getqueue(queuename);
                let hasConsumers: boolean = false;
                if (queue.consumers > 0) {
                    hasConsumers = true;
                }
                if (!hasConsumers) {
                    if (queue.consumer_details != null && queue.consumer_details.length > 0) {
                        hasConsumers = true;
                    } else {
                        hasConsumers = false;
                    }
                }
                if (hasConsumers == false) {
                    hasConsumers = false;
                    throw new Error("No consumer listening at " + queuename);
                    // return bail();
                }
                return hasConsumers;
            }, {
                retries: 10,
                minTimeout: 500,
                maxTimeout: 500,
                onRetry: function (error: Error, count: number): void {
                    result = false;
                    console.warn("retry " + count + " error " + error.message + " getting " + url);
                }
            });
        } catch (error) {
            Logger.instanse.debug(error.message ? error.message : error);
        }
        if (result == true) {
            return result;
        }
        return false;
    }
    static async getvhosts(amqp_url) {
        const q = this.parseurl(amqp_url);
        const options = {
            headers: {
                'Content-type': 'application/x-www-form-urlencoded'
            },
            username: (q as any).username,
            password: (q as any).password
        };
        const _url = 'http://' + q.host + ':' + q.port + '/api/vhosts';
        const response = await got.get(_url, options);
        const payload = JSON.parse(response.body);
        return payload;
    }
    static async getqueues(amqp_url: string, vhost: string = null) {
        const q = this.parseurl(amqp_url);
        const options = {
            headers: {
                'Content-type': 'application/x-www-form-urlencoded'
            },
            username: (q as any).username,
            password: (q as any).password
        };
        let _url = 'http://' + q.host + ':' + q.port + '/api/queues';
        if (!NoderedUtil.IsNullEmpty(vhost)) _url += '/' + encodeURIComponent(vhost);
        const response = await got.get(_url, options);
        const payload = JSON.parse(response.body);
        return payload;
    }
    static async getqueue(amqp_url: string, vhost: string, queuename) {
        // const queues = await amqpwrapper.getqueues(Config.amqp_url);
        // for (let i = 0; i < queues.length; i++) {
        //     let queue = queues[i];
        //     if (queue.name == queuename) {
        //         return queue;
        //     }
        // }
        const q = this.parseurl(amqp_url);
        const options = {
            headers: {
                'Content-type': 'application/x-www-form-urlencoded'
            },
            username: (q as any).username,
            password: (q as any).password,
            timeout: 500, retry: 1
        };
        const _url = 'http://' + q.host + ':' + q.port + '/api/queues/' + encodeURIComponent(vhost) + '/' + encodeURIComponent(queuename);
        const response = await got.get(_url, options);
        const payload = JSON.parse(response.body);
        return payload;
    }
    static async deletequeue(amqp_url: string, vhost: string, queuename) {
        const q = this.parseurl(amqp_url);
        const options = {
            headers: {
                'Content-type': 'application/x-www-form-urlencoded'
            },
            username: (q as any).username,
            password: (q as any).password,
            timeout: 500, retry: 1
        };
        const _url = 'http://' + q.host + ':' + q.port + '/api/queues/' + encodeURIComponent(vhost) + '/' + encodeURIComponent(queuename);
        const response = await got.delete(_url, options);
        const payload = JSON.parse(response.body);
        return payload;
    }
}