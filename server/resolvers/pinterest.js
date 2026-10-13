'use strict';

const { izukaAio, savefbsAio } = require('./thirdparty');

/** Pinterest: engine (native extractor) → izuka aio-v2 → savefbs. */
module.exports = {
  id: 'pinterest',
  name: 'Pinterest',
  methods: [{ name: 'engine' }, izukaAio(), savefbsAio()],
};
