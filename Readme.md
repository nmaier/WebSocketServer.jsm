A WebSocketServer implementation
===
based on `nsIServerSocket`.

What?
---
Implements [RFC 6455](http://tools.ietf.org/html/rfc6455), aka. WebSocket in
a Javascript Code Module suitable for use in Firefox/Thunderbird/Seamonkey
add-ons (and core code, if you like).

Why?
---
I got curious after this [StackOverflow question](http://stackoverflow.com/q/24868227/484441).

How?
---
```js
Cu.import(".../WebSocketServer.jsm");
let server = WebServerSocket(12345 /*port*/, true /* bind all */);
server.onclient = function(client) {
  client.onmessage = function(client, message) {
    // Message is either a string or uint8array, depending on the frame type.
    console.log(client + " sent message", message);
  };
  client.send("hello,world");
};
server.connect();
// ...
server.close();
```

Status?
---
Right now, it is mostly a hacked-together, alpha-grade thingy. If there is
some interest, I might consider putting some more effort in it and write a
proper test suite (right now there is the `test` method...).

Missing:
  - Proper test suite, as already mentioned
  - Continuation frame support.
  - Subprotocols.
  - More resilient error handling.

License?
---
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at http://mozilla.org/MPL/2.0/.
