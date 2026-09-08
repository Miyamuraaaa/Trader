// This bootstrap suppresses arbitrary library/error payloads before loading signer code.
export {};
console.log = console.warn = console.error = () => {};
if (!process.send || process.env.TRADER_PRODUCTION_SOAK !== '1' || process.env.LIVE_TRADING_ENABLED !== 'false') throw new Error('Invalid no-broadcast child startup');
await import('./live-execution-process.js');
