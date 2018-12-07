import { Environment } from '~/utils/environment/Environment';
import { deploy as deployContract } from '~/utils/solidity/deploy';
import { Contracts } from '~/Contracts';

export const deployMatchingMarketAdapter = async (
  environment?: Environment,
) => {
  const address = await deployContract(
    Contracts.MatchingMarketAdapter,
    null,
    environment,
  );

  return address;
};
