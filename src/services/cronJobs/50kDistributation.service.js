import dotenv from 'dotenv';
import Web3 from 'web3';
import cron from 'node-cron';
import DailyReward from '../../models/dailyrewards.model.js';
import path from 'path';
import fs from 'fs';
import User from "../../models/user.model.js";
import TransactionHistory from "../../models/transactions.model.js";

dotenv.config({ path: path.resolve(process.cwd(), '../../../.env') });

const PRIVATE_KEY = process.env.PRIVATE_KEY;

const MAX_BATCH_SIZE = 100; // 100 per pool (Pool A + Pool B = 200 total per call)

if (!PRIVATE_KEY || PRIVATE_KEY.length !== 64) {
    throw new Error("❌ Invalid PRIVATE_KEY! It must be a 64-character hex string without '0x'.");
}

// Web3 & Contract Setup
const WEB3_PROVIDER = process.env.WEB3_PROVIDER;
const web3 = new Web3(new Web3.providers.HttpProvider(WEB3_PROVIDER));

const contractAddress = process.env.DISTRIBUTION;
const contractAddressFK = process.env.FIFTYK_DISTRIBUTION;



console.log('c address'+contractAddress);
const formattedPrivateKey = `0x${PRIVATE_KEY}`;

const ABI = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'DistributionABI.json'), 'utf-8'));
const FIFTYK_ABI = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'fiftyKDistributionABI.json'), 'utf-8'));

const contract = new web3.eth.Contract(ABI, contractAddress);
const fiftyKContract = new web3.eth.Contract(FIFTYK_ABI, contractAddressFK);


const account = web3.eth.accounts.privateKeyToAccount(formattedPrivateKey);
web3.eth.accounts.wallet.add(account);
web3.eth.defaultAccount = account.address;

console.log(`✅ Successfully loaded private key for account: ${account.address}`);

// NFT Addresses
const nftAddresses = {
    Green: process.env.GREEN_NFT,
    Gold:process.env.GOLD_NFT,
    Silver:process.env.SILVER_NFT,
    White:process.env.WHITE_NFT,
    Black:process.env.BLACK_NFT
   };

// 🛠 Send Transaction Helper
const sendTransaction = async (tx) => {
    try {
        const gasPrice = BigInt(await web3.eth.getGasPrice());
        const estimatedGas = BigInt(await tx.estimateGas({ from: account.address }));
        const gasLimit = estimatedGas * BigInt(12) / BigInt(10); // Add 20% buffer
        
        console.log(`⛽ Estimated Gas: ${estimatedGas}, Gas Limit: ${gasLimit}`);

        const txData = {
            from: account.address,
            to: contractAddress,
            gas: Number(gasLimit),
            gasPrice: gasPrice.toString(),
            data: tx.encodeABI(),
        };

        console.log("📡 Sending Transaction: ", txData);

        const signedTx = await web3.eth.accounts.signTransaction(txData, formattedPrivateKey);
        console.log("📜 Signed Transaction:", signedTx);

        const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
       
        console.log(`✅ Transaction Hash: ${receipt.transactionHash}`);
        return receipt.transactionHash; // ✅ Extract and return `hash`
    } catch (error) {
        console.error('❌ Error sending transaction:', error);
        return null;
    }
};

// 📌 Fetch Transaction Details
async function getTransactionDetails(txHash, txType) {
    try {
        const tx = await web3.eth.getTransaction(txHash);
        if (!tx) {
            console.log("❌ Transaction not found!");
            return;
        }

        let currency = "BNB";
        console.log(`🔹 TX Type: ${tx.input === "0x" ? "BNB Transfer" : "Contract Interaction"}`);

        if (tx.input !== "0x") {
            const receipt = await web3.eth.getTransactionReceipt(txHash);
            if (receipt && receipt.logs.length > 0) {
                for (const log of receipt.logs) {
                    if (log.topics[0] === web3.utils.sha3("Transfer(address,address,uint256)")) {
                        let sender = `0x${log.topics[1].slice(26)}`;
                        let receiver = `0x${log.topics[2].slice(26)}`;
                        let amount = BigInt(log.data).toString();

                        // Load token contract to get symbol
                        const tokenContract = new web3.eth.Contract(
                            JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "SSBABI.json"), "utf-8")),
                            log.address
                        );
                        currency = await tokenContract.methods.symbol().call();
                        amount = web3.utils.fromWei(amount, "ether");

                        // Find users with matching receiver wallet
                        const users = await User.find({ decentralizedWalletAddress: receiver });

                        if (users.length === 0) {
                            console.log(`⚠️ No users found for wallet address: ${receiver}`);
                            continue; // Skip saving if no user found
                        }

                        // Save each transaction for all users
                        for (const user of users) {
                            const transaction = new TransactionHistory({
                                userId: user._id,
                                transactionType: txType,
                                amount,
                                currency,
                                transactionHash: txHash,
                                senderWalletId: sender,
                                receiverWalletId: receiver,
                                transactionStatus: "completed",
                            });

                            await transaction.save();
                            console.log(`✅ Transaction saved for User ID: ${user._id}`);
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error("❌ Error fetching transaction:", error);
    }
}


// 🎯 Distribute Investor Bonus & Save Transactions
export const distributeBonusForAllNFTs = async ()=> {
    for (const [tier, nftAddress] of Object.entries(nftAddresses)) {
        if (nftAddress) {  
            try {
                console.log(`🚀 Distributing bonus for ${tier} NFT at ${nftAddress}`);
                const tx = contract.methods.distributeInvestorBonusDaily(nftAddress);
                try {
                    const gas = await tx.estimateGas({ from: account.address });
                    console.log(`Estimated Gas: ${gas}`);
                
                    const txHash = await sendTransaction(tx);
                    await getTransactionDetails(txHash,"investor_bonus");
                } catch (error) {
                    console.error("Transaction Failed! Revert Reason:", error.message);
                }
            } catch (error) {
                console.error(`❌ Error distributing bonus for ${tier}:`, error);
            }
        }
    }
}

/**
 * Splits the list into smaller chunks of MAX_BATCH_SIZE
 */
function splitBatches(poolA, poolB) {
    const batches = [];
    let index = 0;

    while (index < poolA.length || index < poolB.length) {
        const batchA = poolA.slice(index, index + MAX_BATCH_SIZE);
        const batchB = poolB.slice(index, index + MAX_BATCH_SIZE);
        batches.push({ batchA, batchB });
        index += MAX_BATCH_SIZE;
    }

    return batches;
}


//pool A & Pool B bonus
export const distribute50kDailyRewards = async () => {
   
    try {
       
        const poolA = await DailyReward.find({ poolType: "A" }).select("decentralizedWalletAddress");
        const poolB = await DailyReward.find({ poolType: "B" }).select("decentralizedWalletAddress");
   
        const isValidEthAddress = (addr) => web3.utils.isAddress(addr);
           
        const poolAWallets = [...new Set(poolA.map(doc => doc.decentralizedWalletAddress))] .filter(addr => isValidEthAddress(addr));
       
       const poolBWallets = [...new Set(poolB.map(doc => doc.decentralizedWalletAddress))] .filter(addr => isValidEthAddress(addr));;
        
     
       console.log(`Total eligible users: Pool A - ${poolAWallets}, Pool B - ${poolBWallets}`);
        
        if(poolAWallets.length>0){
            const x = ['0x26274263027575e7045362daB332c25B6e7c050E'];
        const txA = fiftyKContract.methods.distribute50kDailyDistribution(x,[]);
        try {
            const gas = await txA.estimateGas({ from: account.address });
            const gasPrice = await web3.eth.getGasPrice();
            const gasLimit = BigInt(gas) * BigInt(12) / BigInt(10);
            const CONTRACT_ADDRESS = process.env.FIFTYK_DISTRIBUTION;
            const txData = {
                from: account.address,
                to: CONTRACT_ADDRESS,
                gas: Number(gasLimit),
                gasPrice,
                data: txA.encodeABI()
            };
    
            const signedTx = await web3.eth.accounts.signTransaction(txData, formattedPrivateKey);
            const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
    
            console.log("✅ Tx Successful! Hash:", receipt.transactionHash);
            await getTransactionDetails(receipt.transactionHash,"pool_A_reward");
        } catch (error) {
            console.error("❌ Transaction Failed:", error.message);
        }
       }
        
        // if(poolBWallets.length>0){
        // const txB = fiftyKContract.methods.distribute50kDailyDistribution([], poolBWallets);
        // try {
        //     const gas = await txB.estimateGas({ from: account.address });
        //     const gasPrice = await web3.eth.getGasPrice();
        //     const gasLimit = BigInt(gas) * BigInt(12) / BigInt(10);
        //     const CONTRACT_ADDRESS = process.env.FIFTYK_DISTRIBUTION;
        //     const txData = {
        //         from: account.address,
        //         to: CONTRACT_ADDRESS,
        //         gas: Number(gasLimit),
        //         gasPrice,
        //         data: txB.encodeABI()
        //     };
    
        //     const signedTx = await web3.eth.accounts.signTransaction(txData, formattedPrivateKey);
        //     const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
    
        //     console.log("✅ Tx Successful! Hash:", receipt.transactionHash);
        //     await getTransactionDetails(receipt.transactionHash,"pool_B_reward");
        // } catch (error) {
        //     console.error("❌ Transaction Failed:", error.message);
        // }
        // }

     } catch (error) {
         console.error('Error distributing daily 50k rewards:', error);
     }
   
};



cron.schedule('0 0 * * *', async() => {
  await distributeBonusForAllNFTs();
  await distribute50kDailyRewards();

  console.log("This function runs after 10 seconds.");

  },{
    timezone: 'Etc/UTC' // 🔥 This ensures it runs at GMT-00
  }
); // 10000 milliseconds = 10 seconds


cron.schedule('31 18 * * *', async () => {
    await distribute50kDailyRewards();
    console.log("This function runs after 10 secondssss.");
  }, {
    timezone: 'Etc/UTC' // Runs at 18:25 UTC (6:25 PM GMT)
  });

console.log('⏳ Cron job set to run daily at GMT+00.');
