// Explicit isolated integration test; never use the production database name.
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { generatePasswordHash } = require('../utils/password');
const User = require('../models/User');
const Device = require('../models/Device');
const Settings = require('../models/Settings');

async function main() {
  const uri = process.env.MONGODB_TEST_URI || 'mongodb://127.0.0.1:33337/homebrain_security_fixture';
  const parsed = new URL(uri);
  if (parsed.port !== '33337' || !/^\/homebrain_security_fixture(?:_[a-z0-9]+)?$/.test(parsed.pathname)) {
    throw new Error('Integration test requires an isolated homebrain_security_fixture database');
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: true });
  const db = mongoose.connection.db;
  assert.match((await db.admin().serverInfo()).version, /^8\./);
  try {
    await db.dropDatabase();
    await Promise.all([User.init(), Device.init(), Settings.init()]);
    const user = await User.create({ email: 'security-fixture@example.invalid', name: 'Security fixture', password: await generatePasswordHash('OnlyForAnIsolatedTest-2026!') });
    assert.equal((await User.findOne({ email: user.email }).lean()).name, 'Security fixture');
    await assert.rejects(User.create({ email: user.email, password: user.password }), { code: 11000 });
    await Device.create([{ name: 'Fixture A', type: 'light', room: 'Fixture room' }, { name: 'Fixture B', type: 'sensor', room: 'Fixture room' }]);
    assert.equal(await Device.countDocuments({ room: 'Fixture room' }), 2);
    const updated = await Device.findOneAndUpdate({ name: 'Fixture A' }, { $set: { room: 'Updated fixture room' } }, { new: true });
    assert.equal(updated.room, 'Updated fixture room');
    const groups = await Device.aggregate([{ $group: { _id: '$type', count: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
    assert.deepEqual(groups.map((g) => g.count), [1, 1]);
    const settings = await Settings.create({});
    assert.ok(await Settings.findById(settings._id).lean());
    const observations = db.collection('security_query_fixture');
    await observations.createIndex({ stationId: 1, observedAt: -1 });
    const date = new Date('2026-10-24T12:00:00Z');
    await observations.insertMany([{ stationId: 'fixture', observedAt: date, rain: 1, optional: null }, { stationId: 'fixture', observedAt: new Date(date.getTime() + 60000), rain: 2 }]);
    assert.equal(await observations.countDocuments({ optional: null }), 2);
    const summary = await observations.aggregate([{ $match: { stationId: 'fixture', observedAt: { $gte: date } } }, { $group: { _id: null, total: { $sum: '$rain' }, first: { $min: '$observedAt' } } }]).toArray();
    assert.equal(summary[0].total, 3);
    assert.deepEqual(summary[0].first, date);
    assert.equal((await observations.find({ stationId: 'fixture' }).hint({ stationId: 1, observedAt: -1 }).sort({ observedAt: -1 }).limit(1).next()).rain, 2);
    await user.deleteOne();
    assert.equal(await User.countDocuments(), 0);
    console.log('%s', JSON.stringify({ ok: true, server: (await db.admin().serverInfo()).version, driver: require('mongodb/package.json').version, mongoose: mongoose.version, checks: ['actual-model CRUD', 'unique indexes', 'updates', 'aggregation', 'settings', 'date ranges', 'null/missing semantics', 'compound-index query', 'delete'] }));
  } finally {
    await db.dropDatabase();
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error('%s', error.message);
  await mongoose.disconnect();
  process.exitCode = 1;
});
