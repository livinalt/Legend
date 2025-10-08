const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { ethers, network } = require("hardhat");

describe("BetEscrow", async function () {
  const { viem } = await ethers.provider.connect();
  const publicClient = await viem.getPublicClient();

  interface Signer {
    address: string;
    }

  interface Contract {
    address: string;
    abi: any;
    write: Record<string, Function>;
    read: Record<string, Function>;
  }

  let deployer: Signer, creator: Signer, opponent: Signer, feeRecipient: Signer;
  interface BetFactoryContract extends Contract {}
  interface ERC20TokenContract extends Contract {}
  interface BetEscrowContract extends Contract {}

  let betFactory: BetFactoryContract, erc20Token: ERC20TokenContract, betEscrow: BetEscrowContract;
  const stake = BigInt(1e18); // 1 ETH or 1e18 tokens
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
  const category = ethers.utils.formatBytes32String("sports");
  const feeBps = 100; // 1% fee

  async function deployBetFactory() {
    const BetFactory = await ethers.getContractFactory(`
      // SPDX-License-Identifier: MIT
      pragma solidity ^0.8.20;
      contract BetFactory {
        uint16 public feeBps;
        address public feeRecipient;
        constructor(uint16 _feeBps, address _feeRecipient) {
          feeBps = _feeBps;
          feeRecipient = _feeRecipient;
        }
        function getFeeInfo() external view returns (uint16, address) {
          return (feeBps, feeRecipient);
        }
      }
    `);
    return await viem.deployContract(BetFactory, [
      feeBps,
      feeRecipient.address,
    ]);
  }

  async function deployERC20() {
    const ERC20 = await ethers.getContractFactory(`
      // SPDX-License-Identifier: MIT
      pragma solidity ^0.8.20;
      import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
      contract TestToken is ERC20 {
        constructor() ERC20("TestToken", "TTK") {
          _mint(msg.sender, 1000 * 10**18);
        }
      }
    `);
    return await viem.deployContract(ERC20);
  }

  async function deployBetEscrow(
    tokenAddress: any,
    opponentAddress = ethers.constants.AddressZero,
    value = 0n
  ) {
    const BetEscrow = await ethers.getContractFactory("BetEscrow");
    return await viem.deployContract(
      BetEscrow,
      [
        creator.address,
        opponentAddress,
        tokenAddress,
        stake,
        deadline,
        category,
        betFactory.address,
      ],
      { value }
    );
  }

  beforeEach(async function () {
    [deployer, creator, opponent, feeRecipient] = await ethers.getSigners();
    betFactory = await deployBetFactory();
    erc20Token = await deployERC20();
  });

  describe("Deployment", function () {
    it("should deploy with correct parameters and emit Created event", async function () {
      betEscrow = await deployBetEscrow(
        ethers.constants.AddressZero,
        opponent.address,
        stake
      );
      const deploymentBlockNumber = await publicClient.getBlockNumber();

      const events = await publicClient.getContractEvents({
        address: betEscrow.address,
        abi: betEscrow.abi,
        eventName: "Created",
        fromBlock: deploymentBlockNumber,
        strict: true,
      });

      assert.equal(events.length, 1);
      assert.equal(events[0].args.creator, creator.address);
      assert.equal(events[0].args.opponent, opponent.address);
      assert.equal(events[0].args.token, ethers.constants.AddressZero);
      assert.equal(events[0].args.stake, stake);
      assert.equal(events[0].args.deadline, deadline);
      assert.equal(events[0].args.category, category);

      const info = await betEscrow.read.info();
      assert.equal(info[0], creator.address); // creator
      assert.equal(info[1], opponent.address); // opponent
      assert.equal(info[2], ethers.constants.AddressZero); // token
      assert.equal(info[3], stake); // stake
      assert.equal(info[4], deadline); // deadline
      assert.equal(info[5], 0); // state (Open)
      assert.equal(info[6], ethers.constants.AddressZero); // winner
      assert.equal(info[7], category); // category
      assert.equal(info[8], betFactory.address); // factory
    });

    it("should revert if creator is zero address", async function () {
      const BetEscrow = await ethers.getContractFactory("BetEscrow");
      await assert.rejects(
        viem.deployContract(
          BetEscrow,
          [
            ethers.constants.AddressZero,
            opponent.address,
            ethers.constants.AddressZero,
            stake,
            deadline,
            category,
            betFactory.address,
          ],
          { value: stake }
        ),
        { message: "creator0" }
      );
    });
  });

  describe("Join (ETH)", function () {
    beforeEach(async function () {
      betEscrow = await deployBetEscrow(
        ethers.constants.AddressZero,
        ethers.constants.AddressZero,
        stake
      );
    });

    it("should allow open invite join and emit Joined event", async function () {
      const tx = await betEscrow.write.join({ value: stake });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: tx.hash,
      });

      const events = await publicClient.getContractEvents({
        address: betEscrow.address,
        abi: betEscrow.abi,
        eventName: "Joined",
        fromBlock: receipt.blockNumber,
        strict: true,
      });

      assert.equal(events.length, 1);
      assert.equal(events[0].args.opponent, opponent.address);
      assert.equal(await betEscrow.read.state(), 1); // Joined
      assert.equal(await betEscrow.read.opponent(), opponent.address);
    });

    it("should revert if ETH stake mismatch", async function () {
      await assert.rejects(betEscrow.write.join({ value: stake / 2n }), {
        message: "eth stake mismatch",
      });
    });

    it("should revert if deadline passed", async function () {
      await network.provider.send("evm_increaseTime", [3601]); // Advance past deadline
      await assert.rejects(betEscrow.write.join({ value: stake }), {
        message: "deadline passed",
      });
    });
  });

  describe("Join (ERC20)", function () {
    beforeEach(async function () {
      betEscrow = await deployBetEscrow(
        erc20Token.address,
        ethers.constants.AddressZero
      );
      await erc20Token.write.approve([betEscrow.address, stake], {
        signer: opponent,
      });
    });

    it("should allow open invite join with ERC20", async function () {
      const tx = await betEscrow.write.join({ signer: opponent });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: tx.hash,
      });

      const events = await publicClient.getContractEvents({
        address: betEscrow.address,
        abi: betEscrow.abi,
        eventName: "Joined",
        fromBlock: receipt.blockNumber,
        strict: true,
      });

      assert.equal(events.length, 1);
      assert.equal(events[0].args.opponent, opponent.address);
      assert.equal(await betEscrow.read.state(), 1); // Joined
      assert.equal(await betEscrow.read.opponent(), opponent.address);
      assert.equal(
        await erc20Token.read.balanceOf([betEscrow.address]),
        stake * 2n
      );
    });

    it("should revert if ETH sent with ERC20", async function () {
      await assert.rejects(
        betEscrow.write.join({ value: stake, signer: opponent }),
        { message: "do not send ETH" }
      );
    });
  });

  describe("Settle", function () {
    beforeEach(async function () {
      betEscrow = await deployBetEscrow(
        ethers.constants.AddressZero,
        opponent.address,
        stake
      );
      await betEscrow.write.join({ value: stake, signer: opponent });
    });

    it("should settle bet and emit Settled event (ETH)", async function () {
      const initialWinnerBalance = await publicClient.getBalance({
        address: opponent.address,
      });
      const initialFeeRecipientBalance = await publicClient.getBalance({
        address: feeRecipient.address,
      });

      const tx = await betEscrow.write.admitLoss([opponent.address], {
        signer: creator,
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: tx.hash,
      });

      const events = await publicClient.getContractEvents({
        address: betEscrow.address,
        abi: betEscrow.abi,
        eventName: "Settled",
        fromBlock: receipt.blockNumber,
        strict: true,
      });

      const total = stake * 2n;
      const fee = (total * BigInt(feeBps)) / 10000n;
      const payout = total - fee;

      assert.equal(events.length, 1);
      assert.equal(events[0].args.winner, opponent.address);
      assert.equal(events[0].args.payout, payout);
      assert.equal(events[0].args.fee, fee);
      assert.equal(await betEscrow.read.state(), 2); // Settled
      assert.equal(await betEscrow.read.winner(), opponent.address);

      const finalWinnerBalance = await publicClient.getBalance({
        address: opponent.address,
      });
      const finalFeeRecipientBalance = await publicClient.getBalance({
        address: feeRecipient.address,
      });
      assert(finalWinnerBalance >= initialWinnerBalance + payout - 1n); // Account for gas
      assert.equal(finalFeeRecipientBalance, initialFeeRecipientBalance + fee);
    });

    it("should revert if not participant", async function () {
      await assert.rejects(
        betEscrow.write.admitLoss([opponent.address], { signer: deployer }),
        { message: "not participant" }
      );
    });
  });

  describe("Refund", function () {
    beforeEach(async function () {
      betEscrow = await deployBetEscrow(
        ethers.constants.AddressZero,
        ethers.constants.AddressZero,
        stake
      );
      await network.provider.send("evm_increaseTime", [3601]); // Advance past deadline
    });

    it("should refund creator if no join", async function () {
      const initialCreatorBalance = await publicClient.getBalance({
        address: creator.address,
      });
      const tx = await betEscrow.write.refundIfNoJoin({ signer: creator });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: tx.hash,
      });

      const events = await publicClient.getContractEvents({
        address: betEscrow.address,
        abi: betEscrow.abi,
        eventName: "Refunded",
        fromBlock: receipt.blockNumber,
        strict: true,
      });

      assert.equal(events.length, 1);
      assert.equal(events[0].args.creator, creator.address);
      assert.equal(events[0].args.amount, stake);
      assert.equal(await betEscrow.read.state(), 3); // Refunded

      const finalCreatorBalance = await publicClient.getBalance({
        address: creator.address,
      });
      assert(finalCreatorBalance >= initialCreatorBalance + stake - 1n); // Account for gas
    });

    it("should revert if deadline not reached", async function () {
      await network.provider.send("evm_setTime", [
        Math.floor(Date.now() / 1000),
      ]); // Reset to before deadline
      await assert.rejects(
        betEscrow.write.refundIfNoJoin({ signer: creator }),
        { message: "deadline not reached" }
      );
    });
  });
});
function beforeEach(arg0: () => Promise<void>) {
    // Register the beforeEach hook for the test suite
    // In node:test, use test.beforeEach; in Mocha, it's global
    // Here, delegate to the global beforeEach if available
    if (typeof (global as any).beforeEach === "function") {
        (global as any).beforeEach(arg0);
    } else if (typeof (global as any).before === "function") {
        (global as any).before(arg0);
    } else {
        throw new Error("No beforeEach hook available in this test environment.");
    }
}

