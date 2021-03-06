/*
 * @file Tests fund's ability to handle a malicious redemption attempts
 *
 * @test Fund receives Malicious token
 * @test redeemShares fails
 * @test redeemSharesEmergency succeeds
 */

import { BN, toWei, randomHex } from 'web3-utils';
import { partialRedeploy } from '~/deploy/scripts/deploy-system';
import { call, deploy, send } from '~/deploy/utils/deploy-contract';
import web3 from '~/deploy/utils/get-web3';
import getAccounts from '~/deploy/utils/getAccounts';

import { BNExpMul } from '~/tests/utils/BNmath';
import { CONTRACT_NAMES, EMPTY_ADDRESS } from '~/tests/utils/constants';
import { investInFund, setupFundWithParams } from '~/tests/utils/fund';
import { getFunctionSignature } from '~/tests/utils/metadata';
import {
  createUnsignedZeroExOrder,
  encodeZeroExTakeOrderArgs,
  signZeroExOrder
} from '~/tests/utils/zeroExV3';

let defaultTxOpts, managerTxOpts, investorTxOpts;
let deployer, manager, investor;
let contracts;
let fund, weth, mln, priceSource, maliciousToken;
let zeroExAdapter, zeroExExchange, erc20Proxy;

beforeAll(async () => {
  [deployer, manager, investor] = await getAccounts();
  defaultTxOpts = { from: deployer, gas: 8000000 };
  managerTxOpts = { ...defaultTxOpts, from: manager };
  investorTxOpts = { ...defaultTxOpts, from: investor };

  const deployed = await partialRedeploy([CONTRACT_NAMES.FUND_FACTORY]);
  contracts = deployed.contracts;
  weth = contracts.WETH;
  mln = contracts.MLN;
  priceSource = contracts.TestingPriceFeed;
  zeroExExchange = contracts.ZeroExV3Exchange;
  zeroExAdapter = contracts.ZeroExV3Adapter;
  erc20Proxy = contracts.ZeroExV3ERC20Proxy;

  const registry = contracts.Registry;
  const fundFactory = contracts.FundFactory;

  maliciousToken = await deploy(
    CONTRACT_NAMES.MALICIOUS_TOKEN,
    ['MLC', 18, 'Malicious']
  );

  await send(priceSource, 'setDecimals', [maliciousToken.options.address, 18], defaultTxOpts);

  await send(
    registry,
    'registerPrimitive',
    [maliciousToken.options.address],
    defaultTxOpts
  );

  fund = await setupFundWithParams({
    integrationAdapters: [zeroExAdapter.options.address],
    initialInvestment: {
      contribAmount: toWei('10', 'ether'),
      investor,
      tokenContract: weth
    },
    manager,
    quoteToken: weth.options.address,
    fundFactory
  });

  // Set price for Malicious Token
  await send(
    priceSource,
    'update',
    [[maliciousToken.options.address], [toWei('1', 'ether')]],
    defaultTxOpts
  );
});

test('Fund receives Malicious token via 0x order', async () => {
  const { vault } = fund;

  const makerAssetAmount = toWei('1', 'ether');
  const unsignedOrder = await createUnsignedZeroExOrder(
    zeroExExchange.options.address,
    await web3.eth.net.getId(),
    {
      makerAddress: deployer,
      makerTokenAddress: maliciousToken.options.address,
      makerAssetAmount,
      takerTokenAddress: weth.options.address,
      takerAssetAmount: toWei('0.5', 'Ether')
    },
  );

  await send(maliciousToken, 'approve', [erc20Proxy.options.address, makerAssetAmount], defaultTxOpts);
  const signedOrder = await signZeroExOrder(unsignedOrder, deployer);

  await send(
    vault,
    'callOnIntegration',
    [
      zeroExAdapter.options.address,
      getFunctionSignature(CONTRACT_NAMES.ORDER_TAKER, 'takeOrder'),
      encodeZeroExTakeOrderArgs(signedOrder, signedOrder.takerAssetAmount),
    ],
    managerTxOpts,
  );
});

test('redeemShares fails in presence of malicious token', async () => {
  const { shares } = fund;

  // Activate malicious token
  await send(maliciousToken, 'startReverting', [], defaultTxOpts);

  await expect(
    send(shares, 'redeemShares', [], investorTxOpts)
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
    send(shares, 'redeemSharesEmergency', [], investorTxOpts)
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
    (await call(priceSource, 'getLiveRate', [maliciousToken.options.address, weth.options.address]))[0]
  );
  const fundMaliciousTokenValue = BNExpMul(preFundHoldingsMaliciousToken, maliciousTokenPrice);

  expect(postTotalSupply).bigNumberEq(preTotalSupply.sub(new BN(investorShares)));
  expect(postWethInvestor).bigNumberEq(preWethInvestor.add(preFundHoldingsWeth));
  expect(postFundHoldingsWeth).bigNumberEq(new BN(0));
  expect(postFundHoldingsMln).toEqual(preFundHoldingsMln);
  expect(postMlnInvestor).toEqual(preMlnInvestor);
  expect(postFundGav).bigNumberEq(fundMaliciousTokenValue);
});
