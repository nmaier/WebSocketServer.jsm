/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var EXPORTED_SYMBOLS = ["WebSocketServer"];

var SERVER_SIGNATURE = "nsISocketServer; NMWebSocketServer/0.1";
var SERVER_PROTOCOL = "13";
var WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
var BUFFER_STEP = 4096;

var {classes: Cc,
     interfaces: Ci,
     utils: Cu,
     results: cr,
     Constructor: CC} = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

var BinaryInputStream = CC("@mozilla.org/binaryinputstream;1",
                           "nsIBinaryInputStream",
                           "setInputStream");
var ServerSocket = CC("@mozilla.org/network/server-socket;1",
                      "nsIServerSocket",
                      "init");
var CryptoHash = CC("@mozilla.org/security/hash;1",
                    "nsICryptoHash",
                    "init");
function SHA1() {
  return new CryptoHash(Ci.nsICryptoHash.SHA1);
}

var MainThread = Services.tm.mainThread;

var state = Object.freeze({
  handshake: 1<<1,
  handshaking: 1<<2,
  connected: 1<<3,
  closing: 1<<4,
  closed: 1<<5,
  error: 1<<6,
});

var opcodes = Object.freeze({
  text_frame: 0x1,
  binary_frame: 0x2,
  close_frame: 0x8,
  ping_frame: 0x9,
  pong_frame: 0xa
});

function Buffer(limit) {
  this.limit = limit;
  this.array = new ArrayBuffer(BUFFER_STEP);
  this.buffer = new Uint8Array(this.array, 0, 0);
};
Buffer.prototype = Object.freeze({
  advance: function(len) {
    if (len > this.length) {
      throw new Error("Buffer.advance(): overflow");
    }
    if (len == this.length) {
      this.buffer = new Uint8Array(this.array, 0, 0);
      return;
    }
    if (len + this.buffer.byteOffset > BUFFER_STEP) {
      let newbuffer = new Uint8Array(this.array,
                                     0,
                                     this.length - len);
      newbuffer.set(this.buffer.subarray(len));
      this.buffer = newbuffer;
      return;
    }
    this.buffer = new Uint8Array(this.array,
                                 this.buffer.byteOffset + len,
                                 this.length - len);
  },
  write: function(data) {
    let len = data.byteLength || data.length;
    if (data.charCodeAt) {
      data = data.split("").map(e => e.charCodeAt(0));
    }
    if (this.free < len) {
      if (this.limit > 0 && this.length + len > this.limit) {
        throw new Error("Buffer.write(): overrun");
      }
      // need to resize array.
      let newarray = new ArrayBuffer(
        Math.ceil((this.length + len) / BUFFER_STEP) * BUFFER_STEP);
      let newbuffer = new Uint8Array(newarray,
                                     0,
                                     this.length + len);
      newbuffer.set(this.buffer);
      newbuffer.set(data, this.length, len);
      this.array = newarray;
      this.buffer = newbuffer;
      return;
    }
    // resize just buffer
    let newbuffer = new Uint8Array(this.array,
                                   this.buffer.byteOffset,
                                   this.length + len);
    newbuffer.set(data, this.length, len);
    this.buffer = newbuffer;
  },
  get data() {
    return this.buffer;
  },
  get length() {
    return this.buffer.byteLength;
  },
  get free() {
    return this.array.byteLength -
      this.buffer.length -
      this.buffer.byteOffset;
  },
  toString: function(len) {
    if (len) {
      if (len > this.length) {
        throw new Error("Buffer.toString(): underrun");
      }
      return String.fromCharCode.apply(null, this.data.subarray(0, len));
    }
    return String.fromCharCode.apply(null, this.data);
  }
});
Buffer = Object.freeze(Buffer);

function InMessage(op, fin, mask, length) {
  this.op = op;
  this.fin = fin;
  this.mask = mask;
  this.remainder = length;
  this.buffer = new Buffer(length);
}
InMessage.prototype = Object.freeze({
  consume: function(buffer) {
    let toread = Math.min(buffer.length, this.remainder);
    if (toread) {
      if (this.mask) {
        let intermediate = new Uint8Array(toread);
        for (let i = 0, m = this.buffer.length % 4; i < toread;
             ++i, m = (++m % 4)) {
          intermediate[i] = buffer.data[i] ^ this.mask[m];
        }
        this.buffer.write(intermediate);
      }
      else {
        this.buffer.write(buffer.data.subarray(0, toread));
      }
      buffer.advance(toread);
      this.remainder -= toread;
    }
    return !this.remainder;
  },
  toUserMessage: function() {
    if (this.op ==  opcodes.text_frame) {
      let d = new TextDecoder("utf-8");
      let rv = d.decode(this.buffer.data);
      delete this.buffer;
      return rv;
    }
    if (this.op == opcodes.binary_frame) {
      let rv = this.buffer.data;
      delete this.buffer;
      return rv;
    }
    throw Error("Not a supported optype");
  }
});
InMessage = Object.freeze(InMessage);

function WebSocketConnection(server, socket) {
  this.socket = socket;
  this.info = "[WebSocketConnection(" +
    socket.host + ":" + socket.port + ")]";
  this.state = state.handshake;
  this.instream = socket.openInputStream(0, 0, 0).
                  QueryInterface(Ci.nsIAsyncInputStream);
  this.outstream = socket.openOutputStream(0, 0, 0).
                   QueryInterface(Ci.nsIAsyncOutputStream);
  this.inbuffer = new Buffer(1<<18);
  this.outbuffer = new Buffer(-1);
  this.onclient = client => {
    server.onclient.call(null, client);
  };
  
  // start receiving!
  this.process();
}
WebSocketConnection.prototype = Object.seal({
  QueryInterface:
   XPCOMUtils.generateQI([Ci.nsIInputStreamCallback,
                          Ci.nsIOutputStreamCallback]),
  process: function() {
    try {
      while (this.inbuffer.length) {
        switch (this.state) {
          case state.handshake:
            this.performHandshake();
            return;
          case state.connected:
            this.processMessages();
            return;
          case state.closing:
            return;
          default:
            throw new Error("Invalid state while processing");
        }
      }
    }
    finally {
      this.onInputStreamReady(this.instream);
    }
  },
  performHandshake: function() {
    try {
      let rawheaders = this.inbuffer.toString();
      let offset = rawheaders.indexOf("\r\n\r\n");
      if (offset < 0) {
        return;
      }
      this.inbuffer.advance(offset + 4);
      let headers = new Map();
      rawheaders.substr(0, offset).split(/\r?\n/g).forEach(e => {
        let [k, v] = e.split(/:/).map(i => i.trim());
        if (!v) {
          v = k;
          k = "METHOD";
        }
        headers.set(k = k.toUpperCase(), v);
      });
      if (headers.get("UPGRADE") != "websocket") {
        throw new Error("Not upgradable");
      }
      if (headers.get("SEC-WEBSOCKET-VERSION") !== SERVER_PROTOCOL) {
        throw new Error("Unsupported websocket version");
      }
      let key = headers.get("SEC-WEBSOCKET-KEY");
      key = key && key.trim();
      if (!key) {
        throw new Error("No key");
      }
      key = key.trim() + WEBSOCKET_GUID;
      let hash = new SHA1();
      hash.update(key.split("").map(e => e.charCodeAt(0)), key.length);
      hash = hash.finish(true);
      this.state = state.handshaking;
      this.write(["HTTP/1.1 101 Switching Protocols",
                 "Upgrade: websocket",
                 "Connection: Upgrade",
                 "Server: " + SERVER_SIGNATURE,
                 "Sec-WebSocket-Accept: " + hash,
                 "\r\n"].join("\r\n"));
    }
    catch (ex) {
      this.write(["HTTP/1.1 400 Bad Request",
                  "Connection: close",
                  "Server: " + SERVER_SIGNATURE,
                  "\r\n"].join("\r\n"));
      this.terminate();
    }
  },
  processMessages: function() {
    while ((this.state & state.connected) && this.inbuffer.length) {
      if (this.msg) {
        if (!this.msg.consume(this.inbuffer)) {
          break;
        }
        let m = this.msg;
        delete this.msg;
        this.deliverMessage(m);
        continue;
      }

      if (this.inbuffer.length < 2) {
        break;
      }
      let data = this.inbuffer.data;
      let offset = 0;
      let op = data[0];
      let fin = (op & 128) != 0;
      op &= 15;

      let pl = data[1];
      let mask = (pl & 128) != 0;
      pl &= 127;

      if (pl == 126) {
        if (this.inbuffer.length < 4) {
          return;
        }
        pl = data[2] * 256 + data[3];
        offset += 4;
      }
      else if (pl == 127) {
        if (this.inbuffer.length < 10) {
          return;
        }
        pl = 0;
        // Dealing with int64 in JS land sucks.
        for (i = 0; i < 8; ++i) {
          pl = pl * 256 + data[2 + i];
        }
        if (pl > Math.pow(2, 53)) {
          throw new Error("Overflowed");
        }
        offset += 10;
      }
      else {
        offset += 2;
      }

      if (mask && this.inbuffer.length >= 4) {
        mask = Array.map(data.subarray(offset, offset + 4),
                         e => e);
        offset += 4;
      }

      if (!mask) {
        throw new Error("Not masked!");
      }
      if (!fin) {
        throw new Error(
          "TODO: Fragmented message currently not supported!");
      }

      this.inbuffer.advance(offset);

      if (this.inbuffer.length >= pl) {
        let m = new InMessage(op, fin, mask, pl);
        if (!m.consume(this.inbuffer)) {
          throw new Error("Supposed to be a complete message?!");
        }
        this.deliverMessage(m);
        continue;
      }

      // partial message
      this.msg = new InMessage(op, fin, mask, pl);
      if (this.msg.consume(this.inbuffer)) {
        throw new Error("Supposed to be a partial message?!");
      }
      break;
    }
  },
  deliverMessage: function(message) {
    if (message.op == opcodes.text_frame ||
        message.op == opcodes.binary_frame) {
      this.callback("onmessage",
                    this.getClient(),
                    message.toUserMessage());
      return;
    }
    if (message.op == opcodes.close_frame) {
      this.state = state.closing;
      this.write(this.createMessage(opcodes.close_frame, ""));
      return;
    }
    if (message.op == opcodes.ping_frame) {
      this.write(this.createMessage(opcodes.pong_frame,
                                    message.buffer.data));
      return;
    }
    throw new Error("Unsupported opcode " + message.op);
  },
  createMessage: function(op, data) {
    let buffer = new Buffer(data.length + 14);
    buffer.write([op | 128]);
    if (data.length >= (1<<16)) {
      buffer.write([255]);
      let len = data.length;
      var l = [];
      for (let i = 0; i < 8; ++i) {
        l.unshift(len % 256);
        len = Math.floor(len / 256);
      }
      buffer.write(l);
    }
    else if (data.length > 125) {
      buffer.write([254,
                    Math.floor(data.length / 256) % 256,
                    data.length % 256]);
    }
    else {
      buffer.write([data.length | 128]);
    }
    let mask = [0x1, 0x2, 0x3, 0x4];
    buffer.write(mask);
    let intermediate = new Uint8Array(data.length);
    for (let i = 0, m = 0; i < data.length; ++i, m = (++m % 4)) {
      intermediate[i] = data[i] ^ mask[m];
    }
    buffer.write(intermediate);
    return buffer.data;
  },
  write: function(data) {
    if (this.state == state.closed) {
      return;
    }
    this.outbuffer.write(data);
    if (this.outbuffer.length) {
      this.onOutputStreamReady(this.outstream);
    }
  },
  send: function(data) {
    if (this.state != state.connected) {
      throw new Error("Connection is not alive!");
    }
    let op = opcodes.binary_frame;
    if (data.charCodeAt) {
      let e = new TextEncoder("utf-8");
      data = e.encode(data);
      op = opcodes.text_frame;
    }
    else if (data.buffer) {
      data = new Uint8Array(data.buffer,
                            data.byteOffset,
                            data.byteLength);
    }
    this.write(this.createMessage(op, data));
  },
  onInputStreamReady: function(stream) {
    try {
      if (this.state & state.closed) {
        return;
      }

      let len, total = 0;
      while ((len = stream.available()) > 0) {
        this.inbuffer.write(
          new BinaryInputStream(stream).readByteArray(len));
        total += len;
      }
      if (total) {
        this.process();
      }
      else {
        this.instream.asyncWait(this, 0, 1, MainThread);
      }
    }
    catch (ex if (ex.result || ex) === Cr.NS_BASE_STREAM_CLOSED) {
      this.terminate();
    }
    catch (ex) {
      this.terminate();
      this.state &= state.error;
    }
  },
  onOutputStreamReady: function(stream) {
    try {
      while (this.outbuffer.length) {
        let data = this.outbuffer.toString(
          Math.min(this.outbuffer.length, 1<<17));
        let written = this.outstream.write(data, data.length);
        if (written > 0) {
          this.outbuffer.advance(written);
        }
      }
      if (this.state == state.handshaking) {
        this.state = state.connected;
        this.callback("onclient", this.getClient());
        this.process();
        return;
      }
      if (this.state == state.closing) {
        this.terminate();
        return;
      }
    }
    catch (ex if (ex.result || ex) === Cr.NS_BASE_STREAM_CLOSED) {
      this.terminate();
    }
    catch (ex if (ex.result || ex) === Cr.NS_ERROR_NET_RESET) {
      this.terminate();
    }
    catch (ex if (ex.result || ex) === Cr.NS_BASE_STREAM_WOULD_BLOCK) {
      stream.asyncWait(this, 0, this.outbuffer.length, MainThread);
    }
    catch (ex) {
      this.terminate();
      this.state &= state.error;
    }
  },
  getClient: function() {
    if (this.virtualClient) {
      return this.virtualClient;
    }
    this.virtualClient = {
      send: this.send.bind(this),
      close: this.close.bind(this),
      toString: this.toString.bind(this)
    };
    Object.defineProperty(this.virtualClient, "onmessage", {
      get: () => this.onmessage,
      set: v => this.onmessage = v,
      enumerable: true
    });
    Object.defineProperty(this.virtualClient, "onclose", {
      get: () => this.onclose,
      set: v => this.onclose = v,
      enumerable: true
    });
    return this.virtualClient;
  },
  close: function() {
    if (this.state < state.closing) {
      this.state = state.closing;
      this.write(this.createMessage(opcodes.close_frame, ""));
    }
  },
  callback: function(name, ...args) {
    try {
      this[name] && this[name].apply(null, args);
    }
    catch (ex) {
      // TODO: Handle how?
    }
  },
  terminate: function() {
    if (!(this.state & state.closed)) {
      this.state = state.closed;
      this.instream.close();
      this.outstream.close();
      this.socket.close(Cr.NS_BASE_STREAM_CLOSED);
      delete this.inbuffer;
      delete this.outbuffer;
      delete this.socket;
      this.callback("onclose", this.getClient());
      delete this.onclose;
      delete this.virtualClient;
    }
  },
  toString: function() {
    return this.info;
  }
});
WebSocketConnection = Object.freeze(WebSocketConnection);

function WebSocketServer(port, bindAll) {
  let wsi = {
    socket: new ServerSocket(port, bindAll, -1),
    QueryInterface:
     XPCOMUtils.generateQI([Ci.nsIServerSocketListener]),
    onSocketAccepted: function(serv, transport) {
      new WebSocketConnection(this, transport);
    },
    onStopListening: function(serv, status) {},
    connect: function() {
      this.socket.asyncListen(this);
    },
    close: function() {
      this.socket.close();
    },
    onclient: function(client) {
      this.onclient && this.onclient(client);
    }.bind(this)
  };

  this.connect = () => {
    wsi.connect();
  };
  this.close = () => {
    wsi.close();
  };
  this.toString = () => {
    return "[ServerSocket(" + (bindAll ? "all," : "remote,") +
      wsi.socket.port + ")]";
  };
};
WebSocketServer = Object.freeze(WebSocketServer);

let test = (function(){
  try {
    var server = new WebSocketServer(12345, true);
    console.log(server.toString());
    server.onclient = function(client) {
      console.log("encountered client: " + client);
      let messages = 0;
      client.onmessage = function(client, message) {
        console.log("encountered message: " + messages + " " + client,
                    message.length, message);
        if (++messages < 20) {
          try {
            client.send("roflcopter");
            client.send(new Uint8Array(1<<10));
          }
          catch (ex) {
            console.error(ex);
          }
        }
        else {
          client.close();
        }
      };
      client.onclose = function(client) {
        console.log(client + " closed");
      }
    };
    server.connect();
    try {
      for (let i = 0; i < 3; ++i) {
        let ws = new WebSocket("ws://localhost:12345");
        ws.onopen = function() {
          ws.onmessage = function (msg) {
            console.log("client message", msg, msg.data);
            ws.send(msg.data);
          };
          let msg = "lol LOL LOL LOL LOL LOL LOL LOL LOL LOL LOL LOL LOL LOL " +
            "LOL LOL LOL LOL LOL LOL LO LOL LOL LOL LOL LOL LOL LOL LOL LOL " +
            "LO LOL LOL LOL LOL LOL LOL LOL LOL LOL LOL ";
          ws.send(msg);
          ws.send(new Uint8Array((1<<16) + 1));
        };
        ws.onerror = function(e) {
          console.error(e.reason, arguments);
        }
        ws.onclose = function(e) {
          console.log("closed");
        }
      }
    }
    finally {
      setTimeout(() => {
        server.close();
        console.log("server closed");
      }, 5000);
    }
  }
  catch (ex) {
    console.error(ex);
  }
});
if ("console" in this) {
  test();
}
