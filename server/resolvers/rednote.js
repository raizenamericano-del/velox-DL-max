'use strict';

const { izukaAio, savefbsAio } = require('./thirdparty');

/** RedNote / Xiaohongshu: engine (XiaoHongShu extractor) → izuka aio-v2 → savefbs. */
module.exports = {
  id: 'rednote',
  name: 'RedNote / 小红书',
  methods: [{ name: 'engine' }, izukaAio(), savefbsAio()],
};
