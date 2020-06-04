pragma solidity 0.6.4;

import './BurnableToken.sol';

contract MLN is BurnableToken {
    constructor() public BurnableToken('MLN', 18, 'Melon Token') {}
}