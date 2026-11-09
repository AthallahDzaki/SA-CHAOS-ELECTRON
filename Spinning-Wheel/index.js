console.log("OKE GUYS")

var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');

var app = express();

const fs = require('fs');
const { WsReconnect } = require('websocket-reconnect');

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'hbs');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

let config = JSON.parse(fs.readFileSync('../config.json'));

const ws = new WsReconnect();

ws.open(`ws://localhost:${config.General.GUIWebsocketPort}`);

ws.on('open', function open() {
    console.log("Cnnected to Server");
});

ws.on('error', (e) => {
    if(e.code != 'ECONNREFUSED')
        console.log(e);
})

ws.on('close', () => {
  console.log('Connection closed');
})

ws.on('reconnect', function open() {
    console.log("Reconnecting to Chaos Server");
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

const server = require("http").createServer(app);
const io = require('socket.io')(server);

io.on('connection', (socket) => {
  console.log('Connected to server');
  socket.on('disconnect', () => {
    console.log('Disconnected from server');
  })
  socket.on('message', (message) => {
    ws.send(message);
  })
});

app.get('/', (req, res) => {
  res.render('index', { title: 'Express' });
})

app.get('/effect', (req, res) => {
  let effect = JSON.parse(fs.readFileSync('../spinwheel-effects.json'));
  effect = effect["effects"];
  io.emit('message', JSON.stringify({
    name: 'effect',
    data: JSON.stringify(effect)
  }))
  res.send('Effect request received');
})

server.listen(80, () => {
  console.log('Server listening on port 80');
})