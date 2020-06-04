/*
 * @file Tests fund's ability to handle a malicious redemption attempts
 *
 * @test Fund receives Malicious token
 * @test redeemShares fails
 * @test redeemSharesEmergency succeeds
 */

import { BN, toWei } from 'web3-utils';
import { call, deploy, send } from '~/deploy/utils/deploy-contract';
import { BNExpMul } from '~/tests/utils/BNmath';
import { CONTRACT_NAMES } from '~/tests/utils/constants';
import { investInFund, setupFundWithParams } from '~/tests/utils/fund';

let web3;
let defaultTxOpts, investorTxOpts;
let deployer, manager, investor;
let fund, weth, mln, priceSource, maliciousToken;

// TODO: run this test when we can successfully deploy contracts on secondary forked chain
beforeAll(async () => {
  web3 = await startChain();
  [deployer, manager, investor] = await web3.eth.getAccounts();
  defaultTxOpts = { from: deployer, gas: 8000000 };
  investorTxOpts = { ...defaultTxOpts, from: investor };

  mln = getDeployed(CONTRACT_NAMES.MLN, web3, mainnetAddrs.tokens.MLN);
  weth = getDeployed(CONTRACT_NAMES.WETH, web3, mainnetAddrs.tokens.WETH);
  priceSource = getDeployed(CONTRACT_NAMES.KYBER_PRICEFEED, web3);
  registry = getDeployed(CONTRACT_NAMES.REGISTRY, web3);
  fundFactory = getDeployed(CONTRACT_NAMES.FUND_FACTORY, web3);

  maliciousToken = await deploy(
    CONTRACT_NAMES.MALICIOUS_TOKEN,
    ['MLC', 18, 'Malicious'],
    {},
    [],
    web3
  );

  await send(
    priceSource,
    'setDecimals',
    [maliciousToken.options.address, 18],
    defaultTxOpts,
    web3
  );

  await send(
    registry,
    'registerAsset',
    [maliciousToken.options.address],
    defaultTxOpts,
    web3
  );

  fund = await setupFundWithParams({
    defaultTokens: [mln.options.address, weth.options.address, maliciousToken.options.address],
    initialInvestment: {
      contribAmount: toWei('1', 'ether'),
      investor, // Buy all shares with investor to make calcs simpler
      tokenContract: weth
    },
    manager,
    quoteToken: weth.options.address,
    fundFactory,
    web3
  });
});

test('Fund receives Malicious token', async () => {
  const { hub } = fund;
  const maliciousTokenAmount = toWei('1', 'ether');

  const tokenAddresses = [maliciousToken.options.address];
  const tokenPrices = [toWei('1', 'ether')];

  // Set price for Malicious Token
  await send(
    priceSource,
    'update',
    [tokenAddresses, tokenPrices],
    defaultTxOpts,
    web3
  );

  // Buy shares with malicious token
  await investInFund({
    fundAddress: hub.options.address,
    investment: {
      contribAmount: maliciousTokenAmount,
      investor,
      tokenContract: maliciousToken
    },
    tokenPriceData: {
      priceSource,
      tokenAddresses,
      tokenPrices
    },
    web3
  });

  // Activate malicious token
  await send(maliciousToken, 'startReverting', [], defaultTxOpts, web3);
});

test('redeemShares fails in presence of malicious token', async () => {
  const { shares } = fund;

  await expect(
    send(shares, 'redeemShares', [], investorTxOpts, web3)
  ).rejects.toThrowFlexible();
});

test('redeemSharesEmergency succeeds in presence of malicious token', async () => {
  const { shares, vault } = fund;

  const preMlnInvestor = new BN(await call(mln, 'balanceOf', [investor]));
  const preWethInvestor = new BN(await call(weth, 'balanceOf', [investor]));

  const preFundHoldingsMaliciousToken = new BN(
    await call(vault, 'assetBalances', [maliciousToken.options.address])
  );
  const preFundHoldingsMln = new BN(
    await call(vault, 'assetBalances', [mln.options.address])
  );
  const preFundHoldingsWeth = new BN(
    await call(vault, 'assetBalances', [weth.options.address])
  );

  const investorShares = await call(shares, 'balanceOf', [investor]);
  const preTotalSupply = new BN(await call(shares, 'totalSupply'));

  await expect(
    send(shares, 'redeemSharesEmergency', [], investorTxOpts, web3)
  ).resolves.not.toThrow();

  const postMlnInvestor = new BN(await call(mln, 'balanceOf', [investor]));
  const postWethInvestor = new BN(await call(weth, 'balanceOf', [investor]));

  const postFundHoldingsMln = new BN(
    await call(vault, 'assetBalances', [mln.options.address])
  );
  const postFundHoldingsWeth = new BN(
    await call(vault, 'assetBalances', [weth.options.address])
  );

  const postTotalSupply = new BN(await call(shares, 'totalSupply'));
  const postFundGav = new BN(await call(shares, 'calcGav'));

  const maliciousTokenPrice = new BN(
    (await call(priceSource, 'getPrice', [maliciousToken.options.address]))[0]
  );
  const fundMaliciousTokenValue = BNExpMul(preFundHoldingsMaliciousToken, maliciousTokenPrice);

  expect(postTotalSupply).bigNumberEq(preTotalSupply.sub(new BN(investorShares)));
  expect(postWethInvestor).bigNumberEq(preWethInvestor.add(preFundHoldingsWeth));
  expect(postFundHoldingsWeth).bigNumberEq(new BN(0));
  expect(postFundHoldingsMln).toEqual(preFundHoldingsMln);
  expect(postMlnInvestor).toEqual(preMlnInvestor);
  expect(postFundGav).bigNumberEq(fundMaliciousTokenValue);
});
