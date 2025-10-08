// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
  BetFactory + BetEscrow

  - Factory deploys an escrow per bet for isolation.
  - Escrow holds ETH/ERC20 stakes and sends fee to factory's feeRecipient on settlement.
  - Factory is Ownable and controls feeBps (max 20%).
  - Flexible category is bytes32.
*/

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./BetMe.sol";

contract BetFactory is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public feeBps; // Basis points: 100 = 1%
    address public feeRecipient; // address where fees are sent to

    uint256 public nextBetId;
    mapping(uint256 => address) public betIdToEscrow;
    address[] public allEscrows;

    event FactoryBetCreated(uint256 indexed betId, address escrow, address indexed creator, address token, uint256 stake, bytes32 category);
    event FeeUpdated(uint16 newFeeBps);
    event FeeRecipientUpdated(address newRecipient);

    // msg.sender to the Ownable constructor
    constructor(uint16 _feeBps, address _feeRecipient) Ownable(msg.sender) {
        require(_feeBps <= 2000, "fee too high");
        require(_feeRecipient != address(0), "recipient0");

        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
        nextBetId = 1;
    }

    /// @notice Create a bet. For ETH bets, send value == stake. For ERC20, caller must approve the factory to pull tokens.
    /// The factory will deploy a BetEscrow and (for ERC20) transfer the creator's stake into the escrow.
    function createBet(
        address token,
        uint256 stake,
        address opponent,
        uint256 deadline,
        bytes32 category
    ) external payable nonReentrant returns (uint256 escrowId, address escrowAddr) {
        require(stake > 0, "stake0");
        require(deadline > block.timestamp, "deadline in past");

        escrowId = nextBetId++;

        if (token == address(0)) {
            require(msg.value == stake, "ETH value mismatch");
            BetEscrow escrow = (new BetEscrow){value: msg.value}(
                msg.sender,
                opponent,
                token,
                stake,
                deadline,
                category,
                address(this)
            );
            escrowAddr = address(escrow);

        } else {

            require(msg.value == 0, "do not send ETH for ERC20");
            IERC20(token).safeTransferFrom(msg.sender, address(this), stake);

            BetEscrow escrow = new BetEscrow(
                msg.sender,
                opponent,
                token,
                stake,
                deadline,
                category,
                address(this)
            );
            escrowAddr = address(escrow);

            IERC20(token).safeTransfer(escrowAddr, stake);
        }

        betIdToEscrow[escrowId] = escrowAddr;
        allEscrows.push(escrowAddr);

        emit FactoryBetCreated(escrowId, escrowAddr, msg.sender, token, stake, category);
        return (escrowId, escrowAddr);
    }

    function getFeeInfo() external view returns (uint16, address) {
        return (feeBps, feeRecipient);
    }

    function setFeeBps(uint16 _feeBps) external onlyOwner {
        require(_feeBps <= 2000, "fee too high");
        feeBps = _feeBps;
        emit FeeUpdated(_feeBps);
    }

    function setFeeRecipient(address _recipient) external onlyOwner {
        require(_recipient != address(0), "recipient0");
        feeRecipient = _recipient;
        emit FeeRecipientUpdated(_recipient);
    }

    function totalEscrows() external view returns (uint256) {
        return allEscrows.length;
    }

    function escrowOf(uint256 betId) external view returns (address) {
        return betIdToEscrow[betId];
    }
}
