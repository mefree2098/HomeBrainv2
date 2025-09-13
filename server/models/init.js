const mongoose = require('mongoose');

const dbInit = async (options = {}) => {
  const mongoUrl = process.env.DATABASE_URL || 'mongodb://localhost/myDb';

  try {
    await mongoose.connect(mongoUrl, options);
    console.log(`Connected to MongoDB at ${mongoUrl}`);
  } catch (err) {
    console.error(`Error connecting to database ${mongoUrl}:`, err);
    throw err;
  }
};

module.exports = dbInit;
