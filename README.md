# serial-http-bridge
This project is a simple webserver which will allow *any* serial device to be controlled over the web.
The only requirements are that the device communicates in ASCII - i.e. commands are sent to it in ASCII, and it responds in ASCII.

The webserver has the following commands:

`/list`

List any serial devices that are connected in a JSON object. Example output might be `{"protocol":1,"devices":[{"id":"ttyACM1"},{"id":"ttyACM2"}]}`
  
`/read/N`

Open a connection to the serial device with id N if it is not opened already, and stream any data read from the device as Server-Sent Events, one event per line.
Multiple simultaneous read connections can be made, they will all receive the same content.
  
`/write/N`

Open a connection to the serial device with id N if it is not opened already, and write the data received in the body of the request (i.e. sent
as a POST) to the device, line by line. No other devices may write while this operation is underway, and any attempt to do so will
receive an HTTP 409 error. If a successful write completed, an HTTP 204 (No Content) will be returned

`/write/N/M`

Open a connection to the serial device with id N if it is not opened already, and write the command M to the device. This is identical
to the method above except it is a GET rather than POST, and is ideal for one-line commands with no context.
  
`/close/N`

Close any open connection to device with id N, and disconnect any open stream. There's no need to run this command normally, the
devices will be opened or closed on demand
  
`/baud/N/M`

Set the baud rate for device with id N to M - this will apply the next time the device is opened.
  
Any other request will return a 404, or if the optional `--static` parameter is given, the server will attempt to server any unrecognised URLs as static files from the specified directory.


## Installation instructions

Install NodeJS, then run

`npm install https://github.com/faceless2/serial-http-bridge.git`

## Example usage

If you have any serial devices connected to your computer, simply run
```
cd $HOME/node_modules/serial-http-bridge
./serial-http-bridge.js --static .
```
then connect to http://localhost:9615/example.html to see a live example. Alternatively run 

```
./serial-http-bridge.js --help
```
for help.

