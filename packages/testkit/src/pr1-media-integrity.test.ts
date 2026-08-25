import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const mediaDirectory = new URL('../../../apps/web/public/mock-media/', import.meta.url);

const expectedMedia = {
  'study-01-portrait.png': [832, 1248, '0a537b1218c0c15491aabf05444127f0b0151536eb7c28cf13f701054fe17514'],
  'study-02-landscape.png': [1200, 800, '0f664cf8be21dd779624b083d69bf18b6cdfac4c28fe1f9a572746b2f6439f0a'],
  'study-03-square.png': [1024, 1024, '6a97233441951b22a4b5f887efb955627a27858e514fd1b9316c1328fc92f223'],
  'study-04-portrait.png': [832, 1248, '7b8d7500d6ac9634ade41a098942521a892c97b62897b3136f0e682369df2e95'],
  'study-05-wide.png': [1536, 864, 'ee9aa50299a9ff4d21d5db39f68134e5ef73e07daf140ed04747b765d73cea22'],
  'study-06-portrait.png': [832, 1248, 'c30a6ad35467980dcd9682d6f73e7f79a69af8070ad3cb3ada7d8c4117db191d'],
  'study-07-square.png': [1024, 1024, 'dfab2191e7926a03b00e3630303068f6329fedaae5db515b5d49d1fb80e6ba1b'],
  'study-08-landscape.png': [1200, 800, 'f620c0c13db67ce68f6439b9fa7cdf034a317a738e7632012438d47a16753da5'],
  'study-09-portrait.png': [832, 1248, '66ec647a4085f8706c591281a03fa0e4dfe4b6608eebc42198826bbeb749375b'],
  'study-10-wide.png': [1536, 864, '74e461332f1623532980caa6f2948bf8864b27488e8b43d52936029f2e70b352'],
  'study-11-square.png': [1024, 1024, 'ed1d5125bfafa4cd09b2414dd1f74803129cb78f1eef4bb5cf18a6361beab29b'],
  'study-12-portrait.png': [832, 1248, 'bbcd5bcfb4bb90ff9def57c59f0d216b55aaddf218ac8591678ad80e78426936'],
  'study-13-vertical.png': [900, 1600, '14cd8082c3422703187a951803e647d515888700e9f6e389823ab6a49883e493'],
} as const;

describe('PR 1 Mock media inventory', () => {
  it('matches the reviewed PNG dimensions and SHA-256 inventory', async () => {
    for (const [fileName, [expectedWidth, expectedHeight, expectedHash]] of Object.entries(expectedMedia)) {
      const bytes = await readFile(new URL(fileName, mediaDirectory));
      expect(bytes.subarray(1, 4).toString('ascii'), fileName).toBe('PNG');
      expect(bytes.readUInt32BE(16), `${fileName} width`).toBe(expectedWidth);
      expect(bytes.readUInt32BE(20), `${fileName} height`).toBe(expectedHeight);
      expect(createHash('sha256').update(bytes).digest('hex'), `${fileName} hash`).toBe(expectedHash);
    }
  });

  it('keeps the tracked visual artifact report synchronized with the design-spec copy', async () => {
    const designReport = await readFile(
      new URL('../../../docs/design-spec/pr1-visual-diff-report.md', import.meta.url),
      'utf8',
    );
    const artifactReport = await readFile(
      new URL('../../../artifacts/visual/pr1/visual-diff-report.md', import.meta.url),
      'utf8',
    );

    expect(artifactReport).toBe(designReport);
  });
});
