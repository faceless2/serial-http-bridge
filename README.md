# serial-http-bridge
This project is a simple webserver which will allow *any* serial device to be controlled over the web.
The only requirements are that the device communicates in ASCII - i.e. commands are sent to it in ASCII, and it responds in ASCII.

The webserver has the following commands:

`/list`

List any serial devices that are connected in a JSON object. Example output might be `{"protocol":1,"devices":[{"id":"ttyACM1"},{"id":"ttyACM2"}]}`
  
`/read/N`

Open a connection to the serial device with id N (if it is not opened already), and stream any data read from the device as Server-Sent Events, one event per line.
Multiple simultaneous read connections can be made, all will receive the same content. The connection to the device will be opened on demand and closed after the last connection is closed.
  
`/write/N`

Open a connection to the serial device with id N (if it is not opened already), and write the data received in the body of the request (i.e. sent
as a POST) to the device, line by line. No other devices may write while this operation is underway, and any attempt to do so will
receive an HTTP 409 error. If the device was opened and content written, an HTTP 204 (No Content) will be returned. If the device cannot be opened an HTTP 503 will be returned. If nothing else is holding this device open (e.g. a read connection) the serial connection will be closed after 5s

`/write/N/M`

Open a connection to the serial device with id N if it is not opened already, and write the command M to the device. This is identical
to the method above except it is a GET rather than POST, and is easier to use for one-line commands with no context.
  
`/close/N`

Close any open connection to device with id N, and disconnect any open "read" streams. There's normally no need to run this command, as the devices will be opened or closed on demand
  
`/baud/N/M`

Set the baud rate for device with id N to M - this will apply the next time the device is opened.
  
Any other request will return a 404, or if the optional `--static` or `--static-package` parameters are given, the server will attempt to serve any unrecognised URLs as static files from the specified directory (relative to the current directory or the package install directory, respectively). The port the device listens to can be specified with the `--port` command line parameter, and the bind address can be set with `--bind`: it defaults to "127.0.0.1" but a value of "any" can also be used to listen on any address.


## Installation instructions

Install NodeJS, then run

`npm install -g https://github.com/faceless2/serial-http-bridge.git`

## Example usage

If you have any serial devices connected to your computer, simply run
```
serial-http-bridge.js --static-package .
```
then connect to http://localhost:9615/example.html to see a live example. Alternatively run 

```
serial-http-bridge.js --help
```
for help.

