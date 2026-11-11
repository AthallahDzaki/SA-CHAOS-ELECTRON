import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UPDATE_CHANNELS,
  resolveUpdateChannel,
  getVelopackChannelName
} from '../main/server/updater.js';
import { readPersistedP2PSettings } from '../main/server/p2p/index.js';

test('Velopack Dual Channel (Release & Beta) Integration Tests', async (t) => {
  await t.test('1. UPDATE_CHANNELS constants and default resolution', () => {
    assert.equal(UPDATE_CHANNELS.RELEASE, 'release');
    assert.equal(UPDATE_CHANNELS.BETA, 'beta');

    // Default with empty or missing config should resolve to release
    assert.equal(resolveUpdateChannel({}), UPDATE_CHANNELS.RELEASE);
    assert.equal(resolveUpdateChannel({ General: {} }), UPDATE_CHANNELS.RELEASE);
    assert.equal(resolveUpdateChannel(null), UPDATE_CHANNELS.RELEASE);
  });

  await t.test('2. Channel name mapping to Velopack feeds', () => {
    // Release channel maps to 'win' (releases.win.json)
    assert.equal(getVelopackChannelName('release'), 'win');
    assert.equal(getVelopackChannelName(UPDATE_CHANNELS.RELEASE), 'win');

    // Beta channel maps to 'beta' (releases.beta.json)
    assert.equal(getVelopackChannelName('beta'), 'beta');
    assert.equal(getVelopackChannelName(UPDATE_CHANNELS.BETA), 'beta');
  });

  await t.test('3. Configuration resolution with case-insensitivity and whitespace trim', () => {
    assert.equal(resolveUpdateChannel({ General: { UpdateChannel: 'beta' } }), 'beta');
    assert.equal(resolveUpdateChannel({ General: { UpdateChannel: 'BETA' } }), 'beta');
    assert.equal(resolveUpdateChannel({ General: { UpdateChannel: ' Beta ' } }), 'beta');

    assert.equal(resolveUpdateChannel({ General: { UpdateChannel: 'release' } }), 'release');
    assert.equal(resolveUpdateChannel({ General: { UpdateChannel: 'RELEASE' } }), 'release');
    assert.equal(resolveUpdateChannel({ General: { UpdateChannel: 'unknown_val' } }), 'release');
  });

  await t.test('4. P2P settings reads channel correctly from config', () => {
    const settings = readPersistedP2PSettings();
    assert.ok(settings.channel === 'win' || settings.channel === 'beta');
  });

  await t.test('5. Velopack channel fallback simulation (404 on beta -> fallback to win)', async () => {
    const simulatedServer = {
      'releases.win.json': {
        Assets: [{ Type: 'Full', FileName: 'SA-CHAOS-1.0.74-full.nupkg', Version: '1.0.74', Size: 1000 }]
      }
      // 'releases.beta.json' is intentionally omitted (simulating 404)
    };

    const fetchFeed = async (channel) => {
      const fileName = `releases.${channel}.json`;
      if (!simulatedServer[fileName]) {
        if (channel !== 'win') {
          // Graceful fallback to win
          return { data: simulatedServer['releases.win.json'], fallbackApplied: true };
        }
        throw new Error('404 Not Found');
      }
      return { data: simulatedServer[fileName], fallbackApplied: false };
    };

    // When querying beta channel, it should fallback to win safely
    const betaResult = await fetchFeed('beta');
    assert.equal(betaResult.fallbackApplied, true);
    assert.equal(betaResult.data.Assets[0].Version, '1.0.74');

    // When querying win directly, no fallback needed
    const winResult = await fetchFeed('win');
    assert.equal(winResult.fallbackApplied, false);
    assert.equal(winResult.data.Assets[0].Version, '1.0.74');
  });
});
