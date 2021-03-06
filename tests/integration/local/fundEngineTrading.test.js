/*
 * @file Tests a fund vault with the Melon Engine
 *
 * @test A fund can take an order once liquid ETH is thawed
 * @test The amount of WETH being asked for by the fund is respected as a minimum
 */

import { encodeFunctionSignature } from 'web3-eth-abi';
import { BN, toWei } from 'web3-utils';
import { partialRedeploy } from '~/deploy/scripts/deploy-system';
import { call, send } from '~/deploy/utils/deploy-contract';
import getAccounts from '~/deploy/utils/getAccounts';

import { BNExpMul } from '~/tests/utils/BNmath';
import { CONTRACT_NAMES } from '~/tests/utils/constants';
import { getFunctionSignature } from '~/tests/utils/metadata';
import { encodeTakeOrderArgs } from '~/tests/utils/formatting';
import { increaseTime } from '~/tests/utils/rpc';
import { setupInvestedTestFund } from '~/tests/utils/fund';

let deployer, manager, investor;
let defaultTxOpts, managerTxOpts, investorTxOpts;
let engine, mln, fund, weth, engineAdapter, kyberAdapter, priceSource;
let contracts;
let mlnPrice, makerQuantity, takerQuantity;
let takeOrderSignature, takeOrderSignatureBytes;
let mlnToEthRate, wethToEthRate;

beforeAll(async () => {
  [deployer, manager, investor] = await getAccounts();
  defaultTxOpts = { from: deployer, gas: 8000000 };
  managerTxOpts = { ...defaultTxOpts, from: manager };
  investorTxOpts = { ...defaultTxOpts, from: investor };
  const deployed = await partialRedeploy([CONTRACT_NAMES.FUND_FACTORY, CONTRACT_NAMES.ENGINE]);
  contracts = deployed.contracts;
  engine = contracts.Engine;
  engineAdapter = contracts.EngineAdapter;
  kyberAdapter = contracts.KyberAdapter;
  priceSource = contracts.TestingPriceFeed;
  mln = contracts.MLN;
  weth = contracts.WETH;

  takeOrderSignature = getFunctionSignature(
    CONTRACT_NAMES.ORDER_TAKER,
    'takeOrder',
  );
  takeOrderSignatureBytes = encodeFunctionSignature(
    takeOrderSignature
  );

  // Set initial prices to be predictably the same as prices when updated again later
  wethToEthRate = toWei('1', 'ether');
  mlnToEthRate = toWei('0.5', 'ether');
  await send(
    priceSource,
    'update',
    [
      [weth.options.address, mln.options.address],
      [wethToEthRate, mlnToEthRate],
    ],
    defaultTxOpts
  );

  mlnPrice = (await priceSource.methods
    .getCanonicalRate(mln.options.address, weth.options.address)
    .call())[0];
  takerQuantity = toWei('0.001', 'ether'); // Mln sell qty
  makerQuantity = BNExpMul(
    new BN(takerQuantity.toString()),
    new BN(mlnPrice.toString()),
  ).toString();
});

test('Setup a fund with amgu charged to seed Melon Engine', async () => {
  await send(engine, 'setAmguPrice', [toWei('1', 'gwei')], defaultTxOpts);

  // TODO: Need to calculate this in fund.js
  const amguTxValue = toWei('10', 'ether');
  fund = await setupInvestedTestFund(contracts, manager, amguTxValue);
});

test('Take an order for MLN on Kyber (in order to take ETH from Engine)', async () => {
  const { vault } = fund;

  const minMakerQuantity = toWei('0.1', 'ether');
  const encodedArgs = encodeTakeOrderArgs({
    makerAsset: mln.options.address,
    makerQuantity: minMakerQuantity,
    takerAsset: weth.options.address,
    takerQuantity: toWei('0.1', 'ether'),
  });

  await expect(
    send(
      vault,
      'callOnIntegration',
      [
        kyberAdapter.options.address,
        takeOrderSignature,
        encodedArgs,
      ],
      managerTxOpts,
    )
  ).resolves.not.toThrow()
});

// TODO: fix failure due to web3 2.0 RPC interface (see increaseTime.js)
test('Trade on Melon Engine', async () => {
  const { vault } = fund;

  // Thaw frozen eth
  await increaseTime(86400 * 32);
  await send(engine, 'thaw');

  const preLiquidEther = new BN(await call(engine, 'liquidEther'));
  const preFundBalanceOfWeth = new BN(await call(weth, 'balanceOf', [vault.options.address]));
  const preFundBalanceOfMln = new BN(await call(mln, 'balanceOf', [vault.options.address]));
  const preFundHoldingsWeth = new BN(
    await call(vault, 'assetBalances', [weth.options.address])
  );
  const preFundHoldingsMln = new BN(
    await call(vault, 'assetBalances', [mln.options.address])
  );

  const makerAsset = weth.options.address;
  const takerAsset = mln.options.address;

  const encodedArgs = encodeTakeOrderArgs({
    makerAsset,
    makerQuantity,
    takerAsset,
    takerQuantity,
  });

  await send(
    vault,
    'callOnIntegration',
    [
      engineAdapter.options.address,
      takeOrderSignature,
      encodedArgs,
    ],
    managerTxOpts,
  );

  const postLiquidEther = new BN(await call(engine, 'liquidEther'));
  const postFundBalanceOfWeth = new BN(await call(weth, 'balanceOf', [vault.options.address]));
  const postFundBalanceOfMln = new BN(await call(mln, 'balanceOf', [vault.options.address]));
  const postFundHoldingsWeth = new BN(
    await call(vault, 'assetBalances', [weth.options.address])
  );
  const postFundHoldingsMln = new BN(
    await call(vault, 'assetBalances', [mln.options.address])
  );

  const fundHoldingsWethDiff = postFundHoldingsWeth.sub(preFundHoldingsWeth);
  const fundHoldingsMlnDiff = preFundHoldingsMln.sub(postFundHoldingsMln);

  expect(fundHoldingsWethDiff).bigNumberEq(postFundBalanceOfWeth.sub(preFundBalanceOfWeth));
  expect(fundHoldingsMlnDiff).bigNumberEq(preFundBalanceOfMln.sub(postFundBalanceOfMln));

  expect(fundHoldingsMlnDiff).bigNumberEq(new BN(takerQuantity));
  expect(fundHoldingsWethDiff).bigNumberEq(preLiquidEther.sub(postLiquidEther));
});

test('Maker quantity as minimum returned WETH is respected', async () => {
  const { vault } = fund;

  const makerQuantity = new BN(mlnPrice.toString()).div(new BN(2)).toString();

  const makerAsset = weth.options.address;
  const takerAsset = mln.options.address;
  const encodedArgs = encodeTakeOrderArgs({
    makerAsset,
    makerQuantity,
    takerAsset,
    takerQuantity,
  });

  await expect(
    send(
      vault,
      'callOnIntegration',
      [
        engineAdapter.options.address,
        takeOrderSignature,
        encodedArgs,
      ],
      managerTxOpts,
    )
  ).rejects.toThrowFlexible(
    "validateAndEmitOrderFillResults: received less buy asset than expected"
  );
});
