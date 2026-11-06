// In-process event bus connecting contact changes to the automation engine.
const { EventEmitter } = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(50);
module.exports = bus;
