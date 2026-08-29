const init = require('../server');

const app = init();

app.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
