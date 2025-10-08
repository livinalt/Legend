// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;


import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";


/// @notice Factory that creates BetEscrow instances. Owner can change fee / fee recipient.
interface IBetFactory {
    function getFeeInfo() external view returns (uint16 feeBps, address feeRecipient);
}


/// @notice Per-bet escrow contract. Minimal and immutable core data stored on deploy.
contract BetEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // States for the single bet
    enum State { Open, Joined, Settled, Refunded }

    // Immutable / set-on-deploy
    address public factory;        // BetFactory address to receive fees
    address public creator;
    address public opponent;       // optional; if 0 => open invites
    address public token;          // 0 => native ETH
    uint256 public stake;          // per-player stake
    uint256 public deadline;       // join deadline
    bytes32 public category;       // for  flexible wide range of category

    // Mutable
    State public state;
    address public winner;

    event Created(address indexed creator, address indexed opponent, address token, uint256 stake, uint256 deadline, bytes32 category);
    event Joined(address indexed opponent);
    event Settled(address indexed winner, uint256 payout, uint256 fee);
    event Refunded(address indexed creator, uint256 amount);

    modifier onlyParticipant() {
        require(msg.sender == creator || msg.sender == opponent, "not participant");
        _;
    }

    constructor(
        address _creator,
        address _opponent,
        address _token,
        uint256 _stake,
        uint256 _deadline,
        bytes32 _category,
        address _factory
    ) payable {
        require(_creator != address(0), "creator0");
        require(_stake > 0, "stake0");
        require(_deadline > block.timestamp, "deadline in past");
        require(_factory != address(0), "factory0");

        factory = _factory;
        creator = _creator;
        opponent = _opponent;
        token = _token;
        stake = _stake;
        deadline = _deadline;
        category = _category;
        state = State.Open;

        // Creator must fund the stake when deploying (ETH) or have approved ERC20 to factory then transferred by factory.
        // For ETH deployment path the factory will deploy with value forwarded. For ERC20 the factory will first pull tokens then pass to escrow.
        emit Created(_creator, _opponent, _token, _stake, _deadline, _category);
    }

    // Accept ETH only fallback (should not be used for ERC20)
    receive() external payable {}

    /// @notice opponent joins by sending stake (ETH) or by factory transferring ERC20
    function join() external payable nonReentrant {
        require(state == State.Open, "not open");

        // if opponent specified, only they can join
        require(opponent == address(0) ? msg.sender != creator : msg.sender == opponent, "invalid joiner");
        require(block.timestamp <= deadline, "deadline passed");

        if (token == address(0)) {

            // ETH path
            require(msg.value == stake, "eth stake mismatch");

        } else {

            // ERC20 path: if joining directly, opponent must have approved this escrow and call join()
            require(msg.value == 0, "do not send ETH");
            IERC20(token).safeTransferFrom(msg.sender, address(this), stake);

        }

        // if open invite, set opponent to joiner
        if (opponent == address(0)) opponent = msg.sender;
        state = State.Joined;

        emit Joined(msg.sender);
    }

    /// @notice Settles the bet when loser admits. Winner is provided to avoid ambiguity.
    /// @dev Only participants can call this and indicate the loser (caller) — winner must be the other.
    function admitLoss(address _winner) external nonReentrant onlyParticipant {
        require(state == State.Joined, "not active");
        require(_winner == creator || _winner == opponent, "winner invalid");

        // caller must be the loser
        require(msg.sender != _winner, "caller cannot be winner");

        uint256 total = stake * 2;
        // Get feeBps from factory
        (uint16 feeBps, address feeRecipient) = IBetFactory(factory).getFeeInfo();
        uint256 fee = (total * feeBps) / 10000;
        uint256 payout = total - fee;

        // mark settled
        winner = _winner;
        state = State.Settled;

        // Transfer payout and fee. For ERC20 do token transfers, for ETH use call.
        if (token == address(0)) {
            // transfer payout to winner
            (bool s1, ) = payable(winner).call{value: payout}("");
            require(s1, "payout failed");
            // transfer fee to factory feeRecipient
            if (fee > 0) {
                (bool s2, ) = payable(feeRecipient).call{value: fee}("");
                require(s2, "fee transfer failed");
            }
        } else {
            IERC20(token).safeTransfer(winner, payout);
            if (fee > 0) {
                IERC20(token).safeTransfer(feeRecipient, fee);
            }
        }

        emit Settled(winner, payout, fee);
    }

    /// @notice Refund creator if no one joins before deadline
    function refundIfNoJoin() external nonReentrant {

        require(state == State.Open, "not refundable");
        require(block.timestamp > deadline, "deadline not reached");
        require(msg.sender == creator, "only creator");

        state = State.Refunded;

        if (token == address(0)) {
            (bool s, ) = payable(creator).call{value: stake}("");
            require(s, "refund failed");
        } else {
            IERC20(token).safeTransfer(creator, stake);
        }

        emit Refunded(creator, stake);
    }

    // View function for frontend to get all core info in one call
    function info() external view returns (
        address _creator,
        address _opponent,
        address _token,
        uint256 _stake,
        uint256 _deadline,
        State _state,
        address _winner,
        bytes32 _category,
        address _factory
    ) {
        return (creator, opponent, token, stake, deadline, state, winner, category, factory);
    }
}

