const logger = require('../utils/logger');

const socketHandler = (socket, io) => {
  logger.info(`WebSocket client connected: ${socket.id}`);

  // Handle subscription to channels
  socket.on('subscribe', async (data) => {
    try {
      const { channels } = data;
      
      if (Array.isArray(channels)) {
        channels.forEach(channel => {
          socket.join(channel);
          logger.debug(`Client ${socket.id} subscribed to ${channel}`);
        });
      }
    } catch (error) {
      logger.error('Subscribe error:', error);
      socket.emit('error', { message: 'Subscription failed' });
    }
  });

  // Handle unsubscription
  socket.on('unsubscribe', (data) => {
    try {
      const { channels } = data;
      
      if (Array.isArray(channels)) {
        channels.forEach(channel => {
          socket.leave(channel);
          logger.debug(`Client ${socket.id} unsubscribed from ${channel}`);
        });
      }
    } catch (error) {
      logger.error('Unsubscribe error:', error);
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    logger.info(`WebSocket client disconnected: ${socket.id}`);
  });

  // Handle errors
  socket.on('error', (error) => {
    logger.error('WebSocket error:', error);
  });
};

// Helper function to emit events to specific channels
const emitToChannel = (io, channel, event, data) => {
  io.to(channel).emit(event, {
    event,
    data,
    timestamp: new Date().toISOString()
  });
};

module.exports = socketHandler;
module.exports.emitToChannel = emitToChannel;






