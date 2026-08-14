const os = require('os');

function getLocalIP() {
  const external = process.env.RENDER_EXTERNAL_URL || process.env.VERCEL_URL || process.env.FLY_APP_NAME;
  if (external) {
    return external.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

module.exports = { getLocalIP };
