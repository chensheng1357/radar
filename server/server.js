var redis = require('redis-sentinel-client'),

    MiniEventEmitter = require('miniee'),
    Type = require('../core').Type,
    Status = require('../core').Status,
    MessageList = require('../core').MessageList,
    Presence = require('../core').Presence,
    Heartbeat = require('heartbeat'),
    logging = require('minilog')('server'),
    hostname = require('os').hostname(),
    Audit = require('./audit.js'),
    DefaultEngineIO = require('engine.io');

// Parse JSON
function parseJSON(data) {
  try {
    var message = JSON.parse(data);
    return message;
  } catch(e) { }
  return false;
}

function Server() {
  this.server = null;
  this.channels = {};
  this.subscriber = null;
  this.subs = {};

  this.timer = new Heartbeat().interval(15000);

}

MiniEventEmitter.mixin(Server);

// Attach to a http server
Server.prototype.attach = function(server, configuration) {
  var self = this;
  var engine = DefaultEngineIO;
  var engineConf;

  configuration || (configuration = {});
  configuration.redis_port || (configuration.redis_port = 26379);
  configuration.redis_host || (configuration.redis_host = 'localhost');
  require('../core').Persistence.setConfig(configuration);
  this.subscriber = redis.createClient(configuration.redis_port, configuration.redis_host);
  if (configuration.redis_auth) {
    this.subscriber.auth(configuration.redis_auth);
  }

  this.subscriber.on('message', function(name, data) {

    logging.debug('#redis_in', name, data);
    if (self.channels[name]) {

      try {
        data = JSON.parse(data);
      } catch(parseError) {
        logging.error("Corrupted key value in redis [" + name + "]. " + parseError.message + ": "+ parseError.stack);
        return;
      }

      self.channels[name].redisIn(data);
    } else {
      logging.warn('#message_not_handled', name, data);
    }
  });


  if(configuration.engineio) {
    engine = configuration.engineio.module;
    engineConf = configuration.engineio.conf;

    self.engineioPath = configuration.engineio.conf ? configuration.engineio.conf.path : "default";
  }

  var server = this.server = engine.attach(server, engineConf);

  server.on('connection', function(client) {
    var oldSend = client.send;
    // for audit purposes
    client.send = function(data) {
      Audit.send(client);
      oldSend.call(client, JSON.stringify(data));
    };

    // event: client connected
    logging.info('#connect', client.id);
    client.send({
      server: hostname, cid: client.id
    });

    client.on('message', function(data) {
      Audit.receive(client);
      self.message(client, data);
    });
    client.on('close', function() {
      // event: client disconnected
      logging.info('#disconnect', client.id);
      for (var name in self.channels) {
        var channel = self.channels[name];
        if (channel.subscribers[client.id]) {
          channel.unsubscribe(client, false);
        }
      }
    });
  });

  this.timer.start();

  setInterval(Audit.totals, 1 * 60 * 1000); // each minute

  // event: server started
  logging.debug(' ');
  logging.debug(' ');
  logging.debug(' ');
  logging.debug(' ');
  logging.debug('#server_start ' + new Date().toString());
  logging.debug(' ');
  logging.debug(' ');
  logging.debug(' ');
  logging.debug(' ');
};

// Process a message
Server.prototype.message = function(client, data) {
  var self =this;
  var message = parseJSON(data);

  // audit messages
  if(message.to == 'audit') {
    Audit.log(client, message);
    return;
  }

  // format check
  if(!message || !message.op || !message.to) {
    logging.warn('#message_rejected', (client && client.id ? client.id : ''), data);
    return;
  }
  logging.info('#message_received', (client && client.id ? client.id : ''), message,
     (this.channels[message.to] ? 'exists' : 'not instantiated'),
     (this.subs[message.to] ? 'is subscribed' : 'not subscribed')
    );

  var subscribed = false, emitted = false;
  var emitOp = function(messageop, client, message) {
    if(subscribed && !emitted) {
      emitted = true;
      logging.debug("emitting "+messageop);
      self.emit(messageop, client, message);
    }
  };
  var res = this.resource(message.to, function() {
    subscribed = true;
    emitOp(message.op, client, message);
  });

  // auth check
  if(res && res.options && res.options.auth) {
    if(typeof res.options.auth !== 'function' || !res.options.auth(message, client)) {
      client.send({
        op: 'err',
        value: 'auth'
      });
      logging.error('#auth_invalid', data);
      return;
    }
  }

  switch(message.op) {
    case 'get':
      res.getStatus && res.getStatus(client, message);
      break;
    case 'set':
      res.setStatus && res.setStatus(client, message, message.ack || false);
      break;
    case 'sync':
      res.sync && res.sync(client, message);
      // also subscribe
    case 'subscribe':
      res.subscribe(client, message.ack || false);
      break;
    case 'unsubscribe':
      res.unsubscribe(client, message.ack || false);
      break;
    case 'publish':
      res.publish && res.publish(client, message, message.ack || false);
      break;
  }

  emitOp(message.op, client, message);
};

// Get or create channel by name
Server.prototype.resource = function(name, subscribed) {
  var self = this;
  if (!this.channels[name]) {
    var opts = Type.getByExpression(name);
    switch(opts.type) {
      case 'status':
        this.channels[name] = new Status(name, this, opts);
        break;
      case 'presence':
        this.channels[name] = new Presence(name, this, opts);
        break;
      case 'message':
        this.channels[name] = new MessageList(name, this, opts);
        break;
    }
    logging.info('#redis_subscribe', name);
    this.subs[name] = true;
    logging.debug("Subscribing to "+name);
    self.channels[name].subscribeTime = Date.now();
    this.subscriber.subscribe(name, function(err) {
      if(self.channels[name]) {
        self.channels[name].subscribeDone = true;
        self.channels[name].subscribeTime = Date.now() - self.channels[name].subscribeTime;
        console.log(err, 'subscribed to '+name+'; took '+self.channels[name].subscribeTime+'ms');
      }
      subscribed && subscribed(name);
    });
  }
  this.channels[name].subscribeDone && subscribed && subscribed(name);
  return this.channels[name];
};

// Destroy empty channel
Server.prototype.destroy = function(name) {
  delete this.channels[name];
  delete this.subs[name];
  logging.info('#redis_unsubscribe', name);
  this.subscriber.unsubscribe(name);
};

Server.prototype.terminate = function() {
  var self = this;
  Object.keys(this.channels).forEach(function(name) {
    self.destroy(name);
  });

  this.timer.clear();
  this.server.close();
  this.subscriber.quit();
};

module.exports = Server;
