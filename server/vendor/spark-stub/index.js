class SparkClientStub {
  constructor() {
    this.connected = false;
  }

  login() {
    return Promise.resolve({ access_token: null });
  }

  listDevices() {
    return Promise.resolve([]);
  }
}

module.exports = SparkClientStub;
