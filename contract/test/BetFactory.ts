const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { ethers } = require("hardhat");

describe("BetFactory", async function () {
  const { viem } = await ethers.provider.connect();
  const publicClient = await viem.getPublicClient();

  interface Signer {
    address: string;
    
  }
  let deployer: Signer, creator: Signer, opponent: Signer, feeRecipient: Signer;
  let betFactory: BetFactoryTestInstance, erc20Token: TestTokenInstance;

  interface BetFactoryTestInstance {
    address: string;
    abi: any;
    write: {
      createBet: (
        args: [
          token: string,
          stake: bigint,
          opponent: string,
          deadline: bigint,
          category: string
        ],
        opts?: { value?: bigint; signer?: any }
      ) => Promise<{ hash: string }>;
      setFeeBps: (args: [number], opts?: { signer?: any }) => Promise<{ hash: string }>;
      setFeeRecipient: (args: [string], opts?: { signer?: any }) => Promise<{ hash: string }>;
    };
    read: {
      feeBps: () => Promise<number>;
      feeRecipient: () => Promise<string>;
      nextBetId: () => Promise<bigint>;
      owner: () => Promise<string>;
      totalEscrows: () => Promise<bigint>;
      betIdToEscrow: (args: [bigint]) => Promise<string>;
      allEscrows: (args: [number]) => Promise<string>;
      getFeeInfo: () => Promise<[number, string]>;
    };
  }

  interface TestTokenInstance {
    address: string;
    abi: any;
    write: {
      approve: (args: [string, bigint], opts?: { signer?: any }) => Promise<{ hash: string }>;
    };
    read: {
      balanceOf: (args: [string]) => Promise<bigint>;
    };
  }

  const stake = BigInt(1e18); // 1 ETH or 1e18 tokens
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
  const category = ethers.utils.formatBytes32String("sports");
  const feeBps = 100; // 1% fee

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

  beforeEach(async function () {
    [deployer, creator, opponent, feeRecipient] = await ethers.getSigners();
    const BetFactory = await ethers.getContractFactory("BetFactory");
    betFactory = await viem.deployContract(BetFactory, [
      feeBps,
      feeRecipient.address,
    ]);
    erc20Token = await deployERC20();
  });

  describe("Deployment", function () {
    it("should deploy with correct initial parameters", async function () {
      assert.equal(await betFactory.read.feeBps(), feeBps);
      assert.equal(await betFactory.read.feeRecipient(), feeRecipient.address);
      assert.equal(await betFactory.read.nextBetId(), 1n);
      assert.equal(await betFactory.read.owner(), deployer.address);
      assert.equal(await betFactory.read.totalEscrows(), 0n);
    });

    it("should revert if feeBps too high", async function () {
      const BetFactory = await ethers.getContractFactory("BetFactory");
      await assert.rejects(
        viem.deployContract(BetFactory, [2001, feeRecipient.address]),
        { message: "fee too high" }
      );
    });

    it("should revert if feeRecipient is zero address", async function () {
      const BetFactory = await ethers.getContractFactory("BetFactory");
      await assert.rejects(
        viem.deployContract(BetFactory, [feeBps, ethers.constants.AddressZero]),
        { message: "recipient0" }
      );
    });
  });

  describe("Create Bet (ETH)", function () {
    it("should create an ETH bet and emit FactoryBetCreated event", async function () {
      const tx = await betFactory.write.createBet(
        [
          ethers.constants.AddressZero,
          stake,
          opponent.address,
          deadline,
          category,
        ],
        { value: stake, signer: creator }
      );
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: tx.hash,
      });

      const events = await publicClient.getContractEvents({
        address: betFactory.address,
        abi: betFactory.abi,
        eventName: "FactoryBetCreated",
        fromBlock: receipt.blockNumber,
        strict: true,
      });

      assert.equal(events.length, 1);
      assert.equal(events[0].args.betId, 1n);
      assert.equal(events[0].args.creator, creator.address);
      assert.equal(events[0].args.token, ethers.constants.AddressZero);
      assert.equal(events[0].args.stake, stake);
      assert.equal(events[0].args.category, category);

      const escrowAddr = events[0].args.escrow;
      assert.equal(await betFactory.read.betIdToEscrow([1n]), escrowAddr);
      assert.equal(await betFactory.read.allEscrows([0]), escrowAddr);
      assert.equal(await betFactory.read.totalEscrows(), 1n);
      assert.equal(await betFactory.read.nextBetId(), 2n);

      const escrow = await viem.getContractAt("BetEscrow", escrowAddr);
      const info = await escrow.read.info();
      assert.equal(info[0], creator.address); // creator
      assert.equal(info[1], opponent.address); // opponent
      assert.equal(info[2], ethers.constants.AddressZero); // token
      assert.equal(info[3], stake); // stake
      assert.equal(info[4], deadline); // deadline
    });

    it("should revert if ETH stake mismatch", async function () {
      await assert.rejects(
        betFactory.write.createBet(
          [
            ethers.constants.AddressZero,
            stake,
            opponent.address,
            deadline,
            category,
          ],
          { value: stake / 2n, signer: creator }
        ),
        { message: "ETH value mismatch" }
      );
    });

    it("should revert if stake is zero", async function () {
      await assert.rejects(
        betFactory.write.createBet(
          [
            ethers.constants.AddressZero,
            0n,
            opponent.address,
            deadline,
            category,
          ],
          { value: 0n, signer: creator }
        ),
        { message: "stake0" }
      );
    });

    it("should revert if deadline in past", async function () {
      const pastDeadline = BigInt(Math.floor(Date.now() / 1000) - 3600);
      await assert.rejects(
        betFactory.write.createBet(
          [
            ethers.constants.AddressZero,
            stake,
            opponent.address,
            pastDeadline,
            category,
          ],
          { value: stake, signer: creator }
        ),
        { message: "deadline in past" }
      );
    });
  });

  describe("Create Bet (ERC20)", function () {
    beforeEach(async function () {
      await erc20Token.write.approve([betFactory.address, stake], {
        signer: creator,
      });
    });

    it("should create an ERC20 bet and emit FactoryBetCreated event", async function () {
      const tx = await betFactory.write.createBet(
        [erc20Token.address, stake, opponent.address, deadline, category],
        { signer: creator }
      );
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: tx.hash,
      });

      const events = await publicClient.getContractEvents({
        address: betFactory.address,
        abi: betFactory.abi,
        eventName: "FactoryBetCreated",
        fromBlock: receipt.blockNumber,
        strict: true,
      });

      assert.equal(events.length, 1);
      assert.equal(events[0].args.betId, 1n);
      assert.equal(events[0].args.creator, creator.address);
      assert.equal(events[0].args.token, erc20Token.address);
      assert.equal(events[0].args.stake, stake);
      assert.equal(events[0].args.category, category);

      const escrowAddr = events[0].args.escrow;
      assert.equal(await betFactory.read.betIdToEscrow([1n]), escrowAddr);
      assert.equal(await betFactory.read.allEscrows([0]), escrowAddr);
      assert.equal(await betFactory.read.totalEscrows(), 1n);
      assert.equal(await betFactory.read.nextBetId(), 2n);

      const escrow = await viem.getContractAt("BetEscrow", escrowAddr);
      assert.equal(await erc20Token.read.balanceOf([escrowAddr]), stake);
    });

    it("should revert if ETH sent with ERC20", async function () {
      await assert.rejects(
        betFactory.write.createBet(
          [erc20Token.address, stake, opponent.address, deadline, category],
          { value: stake, signer: creator }
        ),
        { message: "do not send ETH for ERC20" }
      );
    });
  });

  describe("Fee Management", function () {
    it("should update feeBps and emit FeeUpdated event", async function () {
      const newFeeBps = 200;
      const tx = await betFactory.write.setFeeBps([newFeeBps]);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: tx.hash,
      });

      const events = await publicClient.getContractEvents({
        address: betFactory.address,
        abi: betFactory.abi,
        eventName: "FeeUpdated",
        fromBlock: receipt.blockNumber,
        strict: true,
      });

      assert.equal(events.length, 1);
      assert.equal(events[0].args.newFeeBps, newFeeBps);
      assert.equal(await betFactory.read.feeBps(), newFeeBps);
    });

    it("should revert if feeBps too high", async function () {
      await assert.rejects(betFactory.write.setFeeBps([2001]), {
        message: "fee too high",
      });
    });

    it("should revert if setFeeBps called by non-owner", async function () {
      await assert.rejects(
        betFactory.write.setFeeBps([200], { signer: creator }),
        { message: "Ownable: caller is not the owner" }
      );
    });

    it("should update feeRecipient and emit FeeRecipientUpdated event", async function () {
      const newRecipient = creator.address;
      const tx = await betFactory.write.setFeeRecipient([newRecipient]);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: tx.hash,
      });

      const events = await publicClient.getContractEvents({
        address: betFactory.address,
        abi: betFactory.abi,
        eventName: "FeeRecipientUpdated",
        fromBlock: receipt.blockNumber,
        strict: true,
      });

      assert.equal(events.length, 1);
      assert.equal(events[0].args.newRecipient, newRecipient);
      assert.equal(await betFactory.read.feeRecipient(), newRecipient);
    });

    it("should revert if feeRecipient is zero address", async function () {
      await assert.rejects(
        betFactory.write.setFeeRecipient([ethers.constants.AddressZero]),
        { message: "recipient0" }
      );
    });

    it("should revert if setFeeRecipient called by non-owner", async function () {
      await assert.rejects(
        betFactory.write.setFeeRecipient([creator.address], {
          signer: creator,
        }),
        { message: "Ownable: caller is not the owner" }
      );
    });
  });

  describe("View Functions", function () {
    beforeEach(async function () {
      await betFactory.write.createBet(
        [
          ethers.constants.AddressZero,
          stake,
          opponent.address,
          deadline,
          category,
        ],
        { value: stake, signer: creator }
      );
    });

    it("should return correct fee info", async function () {
      const [feeBpsResult, feeRecipientResult] =
        await betFactory.read.getFeeInfo();
      assert.equal(feeBpsResult, feeBps);
      assert.equal(feeRecipientResult, feeRecipient.address);
    });

    it("should return correct escrow address for betId", async function () {
      const escrowAddr = await betFactory.read.betIdToEscrow([1n]);
      assert.equal(escrowAddr, await betFactory.read.allEscrows([0]));
    });

    it("should return correct total escrows", async function () {
      assert.equal(await betFactory.read.totalEscrows(), 1n);
      await betFactory.write.createBet(
        [
          ethers.constants.AddressZero,
          stake,
          opponent.address,
          deadline,
          category,
        ],
        { value: stake, signer: creator }
      );
      assert.equal(await betFactory.read.totalEscrows(), 2n);
    });
  });
});
