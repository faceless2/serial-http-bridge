#!/usr/bin/env node

// Server-side proxy that can be run (in NodeJS) to relay data between
// one or more serial devices and the web. This is completely generic
// and will work with any serial device that communicates in ASCII.
//
// /list         - return JSON structure listing devices.
// /read/N       - open Server-Sent Event stream reading from device N
// /baud/N/M     - set baud rate for device N to M (call before read/write)
// /write/N/M    - write single command M to device N
// /write/N      - write commands read from POST, on-per-line, to device N
// /close/N      - force disconnect of all sessions to device N
// /N            - anything else loads a resource from the "static" directory
//
//
// The "/list" method will return a structure like { devices: [ {id: N}, ...] }
// where N is the unique ID in the read/write/baud/close methods. Other fields may
// be included too
//
// Multiple "read" connections may be made to a single device; they will
// all receive the same data. The serial device will be connected to on the
// first stream open, and disconnected after the last stream is closed.
// Data is returned from the device as an unamed event, and metadata about the
// connection is returned as part of a "connection" event
//
// A "write" can be received from any client, but will not be interleaved with
// another client's writes. If the POST method sends multiple commands they will
// all complete before the next write method can complete successfully. If a write
// completes it will return an HTTP 204, and if it cannot complete because another
// write is executing it will return HTTP 409. Writes will also open a device on
// demand, and if nothing else is reading or writing to it the device will be closed
// after 5s
//

const http = require("http");
const SerialPort = require("serialport");
const serveStatic = require("serve-static");
const finalhandler = require("finalhandler");
const path = require("path");

var root;
var bind = "127.0.0.1";
const protocol = "1";
const autotimeout = 5000; // the number of ms after a write to close an unused device
var port = 9615;

for (var i=2;i<process.argv.length;i++) {
    var a = process.argv[i];
    if (a == "--static") {
        root = process.argv[++i];
    } else if (a == "--port") {
        port = process.argv[++i];
    } else if (a == "--bind") {
        bind = process.argv[++i];
        if (bind == "any") {
            bind = "::"
        }
    } else {
        console.log("Usage: node server [--root <dir>] [--port <port>] [--bind <ip | 'any'>]");
        console.log("  --static     the optional directory to server any static files from");
        console.log("  --port       specify the port the webserver should run on (default:9615)");
        console.log("  --bind       specify the IP the webserver should bind to, or 'any' to listen");
        console.log("               on any address (default: 'localhost')");
        console.log();
        process.exit(-1);
    }
}
if (root) {
    root = path.resolve(path.dirname(require.main.filename), root);
}

console.log("# Starting webserver on port "+port);

var devices = {};

/**
 * Given a serialport, return a unique ID for that port.
 */
function createId(port) {
    return port.comName.replace(/^\/dev\//, "").replace(/:/,"");
}

function Device(id, props) {
    var that = this;
    this.id = createId(props);
    this.path = props.comName;
    this.props = JSON.parse(JSON.stringify(props));
    this.props.id = id;
    delete this.props.comName;
    var autoclose;
    var ping;
    var lock = null;

    var sessions = [];
    var serialPort = new SerialPort(this.path, {
        autoOpen: false,
        parser: SerialPort.parsers.readline("\n")
    });

    serialPort.on("error", function(err) {
        send({type: "servermessage", "state": "error", "error": err.message}, "connection");
        console.log(that.path+": Error: "+err.message);
        that.close();
    });

    serialPort.on("open", function() {
        send({type: "servermessage", "state": "connected"}, "connection");
        console.log(that.path+": opened");
    });

    serialPort.on("close", function() {
        send({type: "servermessage", "state": "closed"} , "connection");
        console.log(that.path+": closed");
        that.close();
        lock = null;
    });

    function keepalive() {
        for (var i=0;i<sessions.length;i++) {
            sessions[i].write(":\n\n");
        }
    }

    function send(data, eventtype) {
        if (typeof data !== "string") {
            data = JSON.stringify(data);
        }
        data = "data: " + data.replace(/\n/, "\ndata: ");
        if (eventtype) {
            data = "event: "+eventtype + "\n" + data;
        }
        for (var i=0;i<sessions.length;i++) {
            sessions[i].write(data + "\n\n");
        }
    }

    serialPort.on("data", send);

    /**
     * Open the connection to the serial port
     * @param callback the function to call when the open completes
     */
    this.open = function(callback) {
        send({type: "servermessage", "state": "connecting"}, "connection");
        console.log(that.path+": opening");
        if (that.baudRate) {
            serialPort.update({baudRate: that.baudRate}, function() {
                serialPort.open(callback);
            });
        } else {
            serialPort.open(callback);
        }
        ping = setInterval(keepalive, 50000);
    };

    /**
     * Close any connections to this device, terminating
     * any open read sessions and closing the COM port if open
     */
    this.close = function() {
        if (serialPort.isOpen()) {
            serialPort.close();
            return;
        }
        for (var i=0;i<sessions.length;i++) {
            sessions[i].end();
        }
        sessions = [];
        clearInterval(ping);
        ping = null;
    }

    /**
     * Write the specified data to the serial port.
     * Each line of the data will be written in sequence
     * to the port, with no other writes from other clients
     * interleaved.
     * If the port is not open when this method is called,
     * it will be opened
     *
     * @param data the data to write, which may be an Array or a String with newlines
     * @param source a text-representation of the source of the data, for logging
     * @param callback if not null, this method will be called when the data is all written
     * @param session should be null when called externally
     * @return true if this method is about to write, false if someone else is holding the write lock
     */
    this.write = function(data, source, callback, session) {
        if (!session) {
            session = Math.round(Math.random() * 0xFFFFFFFF);
        }
        if (lock != null && lock != session) {
            return false;
        }
        lock = session;

        if (!serialPort.isOpen()) {
            that.open(function() {
                that.write(data, source, callback, session);
            });
            return true;
        }
        if (typeof data == "string") {
            data = data.split(/[\r\n]/);
        }
        var send = function() {
            if (data.length) {
                var line = data.shift();
                if (line.length > 0) {
                    if (/^__sleep (\d+)$/.test(line)) {
                        setTimeout(send, RegExp.$1);
                    } else {
                        console.log(that.path+": sending \""+line+"\" from \""+source+"\"");
                        serialPort.write(line + "\n", function() {
                            serialPort.drain(send);
                        });
                    }
                } else {
                    // Skip empty line
                    send();
                }
            } else {
                if (autoclose) {
                    clearTimeout(autoclose);
                }
                autoclose = setTimeout(function() {
                    if (sessions.length == 0) {
                        that.close();
                    }
                }, autotimeout);
                if (callback) {
                    callback();
                }
                lock = null;
            }
        };
        send();
        return true;
    };

    /**
     * Add an HTTP response to the list of responses that are
     * receiving the data read from the serial port. IF the COM
     * port is not open when this method is called, it is opened.
     * 
     * @param res the response
     * @param source a text-representation of the source of the data, for logging
     */
    this.add = function(res, source) {
        sessions.push(res);
        if (!serialPort.isOpen()) {
            that.open();
        }
        console.log(that.path+": streaming to \""+source+"\"");
        res.connection.addListener("close", function() {
            console.log(that.path+": closing stream to \""+source+"\"");
            var i = sessions.indexOf(res);
            if (i >= 0) {
                sessions.splice(i, 1);
            }
            if (sessions.length == 0) {
                that.close();
            }
        });
    };
}

http.createServer(function (req, res) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.socket.remoteAddress || req.connection.socket.remoteAddress;
    var serve = root ? serveStatic(root, {}) : null;

    if (req.url == "/list") {
        SerialPort.list(function(err, ports) {
            var seen = {};
            ports.forEach(function(port) {
                var id = createId(port);
                var device = devices[id];
                if (!device) {
                    device = devices[id] = new Device(id, port);
                }
                seen[id] = devices;
            });
            var o = {};
            o.protocol = protocol;
            o.devices = [];
            for (var id in devices) {
                if (!seen[id]) {
                    devices[id].close();
                    delete devices[id];
                } else {
                    o.devices.push(devices[id].props);
                }
            }
            res.writeHead(200, {"Content-Type": "application/json"});
            res.write(JSON.stringify(o));
            res.end();
        });
    } else if (/^\/baud\/([^\/]*)\/(\d+)$/.test(req.url)) {
        var id = RegExp.$1;
        var device = devices[id];
        if (device) {
            device.baud = RegExp.$2;
        }
        res.writeHead(204, {});
        res.end();
    } else if (/^\/read\/([^\/]*)$/.test(req.url)) {
        var id = RegExp.$1;
        var device = devices[id];
        if (device) {
            res.writeHead(200, {"Content-Type":"text/event-stream", "Cache-Control":"no-cache", "Connection":"keep-alive"});
            device.add(res, ip);
        } else {
            res.writeHead(404);
            res.end();
        }
    } else if (/^\/write\/([^\/]*)\/(.*)/.test(req.url) && req.method == "GET") {
        var id = RegExp.$1;
        var data = RegExp.$2;
        var device = devices[id];
        if (device) {
            if (!device.write(data, ip, function() {
                res.writeHead(204, {});
                res.end();
            })) {
                res.writeHead(409, {});
                res.end();
            }
        } else {
            res.writeHead(404);
            res.end();
        }
    } else if (/^\/write\/([^\/]*)$/.test(req.url) && req.method == "POST") {
        var id = RegExp.$1;
        var device = devices[id];
        if (device) {
            var body = "";
            req.on("data", function(data) {
                body += data;
                if (body.length > 4096) {
                    req.connection.destroy();
                }
            });
            req.on("end", function() {
                if (!device.write(body, ip, function() {
                    res.writeHead(204, {});
                    res.end();
                })) {
                    res.writeHead(409, {});
                    res.end();
                }
            });
        } else {
            res.writeHead(404);
            res.end();
        }
    } else if (/^\/close\/([^\/]*)$/.test(req.url)) {
        var id = RegExp.$1;
        var device = devices[id];
        if (device) {
            console.log(device.path+": force close from \""+ip+"\"");
            device.close()
            res.writeHead(204);
            res.end();
        } else {
            res.writeHead(404);
            res.end();
        }
    } else if (serve) {
        serve(req, res, finalhandler(req, res));
    } else {
        res.writeHead(404);
        res.end();
    }
}).listen(port, bind);
