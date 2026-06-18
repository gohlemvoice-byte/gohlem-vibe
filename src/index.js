require('dotenv').config();
const app = require('./dashboard');
const { PORT = 3000 } = process.env;

app.listen(PORT, () => {
  console.log(`Gohlem.ai running on port ${PORT}`);
});
