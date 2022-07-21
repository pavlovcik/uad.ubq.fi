import { task, types } from "hardhat/config";
import "@nomiclabs/hardhat-waffle";
import { BigNumber, Signer } from "ethers";
import * as dotenv from "dotenv";


import { ICurveFactory } from "../artifacts/types/ICurveFactory";
import { UbiquityAlgorithmicDollar } from "../artifacts/types/UbiquityAlgorithmicDollar";
import { UbiquityAlgorithmicDollarManager } from "../artifacts/types/UbiquityAlgorithmicDollarManager";
import { IMetaPool } from "../artifacts/types/IMetaPool";
import { BondingV2 } from "../artifacts/types/BondingV2";
import { ERC20 } from "../artifacts/types/ERC20";
import pressAnyKey from "../utils/flow";
import { TWAPOracle } from "../artifacts/types/TWAPOracle";
import { DEPLOYMENT_OVERRIDES, FORKING_CHAIN_ID } from "./constants"
import { A_PRECISION, get_burn_lp_amount } from "./utils"

dotenv.config();

const {
  API_KEY_ALCHEMY
} = process.env;

task(
  "priceReset",
  "PriceReset can push uAD price lower or higher by burning LP token for uAD or 3CRV from the bonding contract"
)
  .addParam("price", "The target price of uAD")
  .addOptionalParam(
    "dryrun",
    "if false will use account 0 to execute price reset",
    true,
    types.boolean
  )
  .addOptionalParam(
    "twapUpdate",
    "if true will call the update function of twap oracle",
    false,
    types.boolean
  )
  .setAction(
    async (
      taskArgs: {
        price: number;
        dryrun: boolean;
        twapUpdate: boolean
      },
      { ethers, network, getNamedAccounts, deployments }
    ) => {
      console.log("started....");
      const { chainId } = network.config;
      const OVERRIDES_PARAMS = DEPLOYMENT_OVERRIDES[chainId!];
      const { price, dryrun, twapUpdate } = taskArgs;

      let admin: Signer;
      let adminAdr: string;
      if (dryrun) {
        // await resetFork(taskArgs.blockheight);
        adminAdr = OVERRIDES_PARAMS.deployer;
        const impersonate = async (account: string): Promise<Signer> => {
          let provider = new ethers.providers.JsonRpcProvider(
            "http://localhost:8545"
          );
          await provider.send("hardhat_impersonateAccount", [account]);
          return provider.getSigner(account);
        };
        admin = await impersonate(adminAdr);
      } else {
        [admin] = await ethers.getSigners();
        adminAdr = await admin.getAddress();
      }

      if (chainId === FORKING_CHAIN_ID) {
        // impersonate deployer account
        await network.provider.request({
          method: "hardhat_impersonateAccount",
          params: [OVERRIDES_PARAMS.deployer]
        });

        admin = await ethers.provider.getSigner(OVERRIDES_PARAMS.deployer);
        adminAdr = await admin.getAddress();

      }
      console.log({ admin: adminAdr, chainId })
      let managerAddress;
      try {
        const managerDeployments = await deployments.get("UbiquityAlgorithmicDollarManager");
        managerAddress = managerDeployments?.address || OVERRIDES_PARAMS.UbiquityAlgorithmicDollarManagerAddress;
      } catch (error: unknown) {
        managerAddress = OVERRIDES_PARAMS.UbiquityAlgorithmicDollarManagerAddress;
      }
      if (!managerAddress) {
        throw new Error(`UbiquityAlgorithmicDollarManager address empty!`);
      }

      const manager = (await ethers.getContractAt(
        "UbiquityAlgorithmicDollarManager",
        managerAddress
      )) as UbiquityAlgorithmicDollarManager;
      const uADAdr = await manager.dollarTokenAddress();
      const uAD = (await ethers.getContractAt(
        "UbiquityAlgorithmicDollar",
        uADAdr
      )) as UbiquityAlgorithmicDollar;

      const curve3CrvToken = OVERRIDES_PARAMS.curve3CrvToken;
      if (!curve3CrvToken) {
        throw new Error(`Not configured 3CRV token address`);
      }
      const curveToken = (await ethers.getContractAt(
        "ERC20",
        curve3CrvToken
      )) as ERC20;
      const treasuryAddr = await manager.treasuryAddress();
      const bondingAddr = await manager.bondingContractAddress();
      const bonding = (await ethers.getContractAt(
        "BondingV2",
        bondingAddr
      )) as BondingV2;
      const metaPoolAddr = await manager.stableSwapMetaPoolAddress();

      const metaPool = (await ethers.getContractAt(
        "IMetaPool",
        metaPoolAddr
      )) as IMetaPool;

      const A = await metaPool.A();
      const fee = await metaPool.fee();
      const balances = await metaPool.get_balances();
      const totalSupply = await metaPool.totalSupply();

      const uADBalanceOfMetaPool = balances[0];
      const curve3CRVBalanceOfMetaPool = balances[1];
      const impactedPrice = Math.floor(price * 10);
      const expectedUADAmount = curve3CRVBalanceOfMetaPool.div(impactedPrice).mul(10);
      console.log({
        bondingAddr, metaPoolAddr, uADBalance: uADBalanceOfMetaPool.toString(),
        curve3CRVBalance: curve3CRVBalanceOfMetaPool.toString(),
        expectedUADAmount: expectedUADAmount.toString(),
        impactedPrice
      });
      if (expectedUADAmount.gt(uADBalanceOfMetaPool)) {
        throw new Error(`We don't currently support to make the price lower. price: ${price}, uADAmount: ${ethers.utils.formatEther(uADBalanceOfMetaPool)}, expectedUAD: ${ethers.utils.formatEther(expectedUADAmount)}`)
      }

      console.log(`Calculating burn amount to reset price...`);

      const amp = A.mul(A_PRECISION);
      const base_pool = OVERRIDES_PARAMS.curve3CrvBasePool;
      const curveBasePool = (await ethers.getContractAt("IMetaPool", base_pool)) as IMetaPool;
      const virtual_price = await curveBasePool.get_virtual_price();
      const amounts: BigNumber[] = [uADBalanceOfMetaPool.sub(expectedUADAmount), BigNumber.from("0")];

      console.log({
        amp: amp.toString(), virtual_price: virtual_price.toString(), fee: fee.toString(),
        balances: balances.map(balance => balance.toString()), totalSupply: totalSupply.toString(),
        amounts: amounts.map(amount => amount.toString())
      });

      const burn_lp_amount = get_burn_lp_amount({ amp, virtual_price, fee, balances, totalSupply, amounts });


      const available_lp_amount = await metaPool.balanceOf(bondingAddr);
      console.log({
        burn_lp_amount: burn_lp_amount.toString(),
        available_lp_amount: available_lp_amount.toString()
      });

      if (available_lp_amount.lt(burn_lp_amount)) {
        throw new Error(`Not enough lp amount for burn in bonding contract, needed: ${burn_lp_amount.toString()}, available: ${available_lp_amount.toString()}`)
      }

      await pressAnyKey(
        "Press any key if you are sure you want to continue ..."
      );

      const tx = await bonding.connect(admin).uADPriceReset(burn_lp_amount);
      console.log(`tx mined! hash: ${tx.hash}`);
      await tx.wait(1);
      console.log(`price reset tx confirmed!`);

      const new_balances = await metaPool.get_balances();
      console.log({ new_balances: new_balances.map(balance => balance.toString()) });

    }
  );