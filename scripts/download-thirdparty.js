const rp = require('request-promise');
const fs = require('fs');
const thirdpartyDir = './thirdparty';

const kyberContractNames = [
  'ConversionRates',
  'ExpectedRate',
  'FeeBurner',
  'KyberNetwork',
  'KyberNetworkProxy',
  'KyberReserve',
  'WhiteList',
];
const oasisDexContractNames = [
  'OasisDexExchange',
];
const uniswapContractNames = [
  'UniswapExchange',
  'UniswapFactory',
];
const zeroExV2ContractNames = [
  'ZeroExV2ERC20Proxy',
  'ZeroExV2Exchange',
];
const zeroExV3ContractNames = [
  'ZeroExV3ERC20Proxy',
  'ZeroExV3Exchange',
  'ZeroExV3Staking',
  'ZeroExV3StakingProxy',
  'ZeroExV3ZrxVault'
];

const contractNames = [].concat(
  kyberContractNames,
  oasisDexContractNames,
  uniswapContractNames,
  zeroExV2ContractNames,
  zeroExV3ContractNames,
);

function findStringArrayDuplicate(array) {
  const uniqueItems = {};
  for (const item of array) {
    if (typeof item !== 'string') throw new Error(`${item} is not a string.`)

    if (item in uniqueItems) {
      return item;
    }
    uniqueItems[item] = true;
  }
}

const requestOptions = (fileExtension) => (contractName) => {
  return {
    uri: `https://raw.githubusercontent.com/melonproject/thirdparty-artifacts/master/thirdparty/${contractName}${fileExtension}`
  }
};

const abiRequestOptions = requestOptions('.abi');
const bytecodeRequestOptions = requestOptions('.bin');

function mkdir(dir) {
  if (!fs.existsSync(dir)){
      fs.mkdirSync(dir);
  }
}

async function wrapRequestResult(request, contractName, fileExtension) {
  const result = await request;

  return {
    contractName,
    fileExtension,
    content: result
  };
}

(async () => {

  const duplicate = findStringArrayDuplicate(contractNames);
  if (duplicate !== undefined) {
    throw new Error(`${duplicate} is duplicated.`);
  }

  const requests = [];
  for (const cName of contractNames) {
    {
      const request = rp(abiRequestOptions(cName));
      const abiReq = wrapRequestResult(request, cName, '.abi');
      requests.push(abiReq);
    }
    {
      const request = rp(bytecodeRequestOptions(cName));
      const bytecodeReq = wrapRequestResult(request, cName, '.bin');
      requests.push(bytecodeReq);
    }
  }

  try {
    const results = await Promise.all(requests);
    mkdir(thirdpartyDir);
    for (const result of results) {
      const { contractName, fileExtension, content } = result;
      fs.writeFileSync(`${thirdpartyDir}/${contractName}${fileExtension}`, content);
    }
  }
  catch (e) {
    console.log(e)
  }

})();
