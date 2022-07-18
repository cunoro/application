import { ethers, constants } from "ethers";
import { getTokenPrice } from "../../helpers";
import { calculateUserBondDetails, getBalances } from "./account-slice";
import { SabTokenContract, SSabTokenContract } from "../../abi";
import { getAddresses } from "../../constants";
import { fetchPendingTxns, clearPendingTxn } from "./pending-txns-slice";
import { createSlice, createSelector, createAsyncThunk } from "@reduxjs/toolkit";
import { JsonRpcProvider, StaticJsonRpcProvider } from "@ethersproject/providers";
import { fetchAccountSuccess } from "./account-slice";
import { Bond } from "../../helpers/bond/bond";
import { Networks } from "../../constants/blockchain";
import { getBondCalculator } from "../../helpers/bond-calculator";
import { RootState } from "../store";
import { bend } from "../../helpers/bond";
import { error, warning, success, info } from "../slices/messages-slice";
import { messages } from "../../constants/messages";
import { getGasPrice } from "../../helpers/get-gas-price";
import { metamaskErrorWrap } from "../../helpers/metamask-error-wrap";
import { sleep } from "../../helpers";
import { BigNumber } from "ethers";
import { IAllBondData } from "src/hooks/bonds";
import { getMarketPrice } from "../../helpers/get-market-price";

interface IChangeApproval {
    bond: Bond;
    provider: StaticJsonRpcProvider | JsonRpcProvider;
    networkID: Networks;
    address: string;
}

export const changeApproval = createAsyncThunk("bonding/changeApproval", async ({ bond, provider, networkID, address }: IChangeApproval, { dispatch }) => {
    if (!provider) {
        dispatch(warning({ text: messages.please_connect_wallet }));
        return;
    }

    const signer = provider.getSigner();
    const reserveContract = bond.getContractForReserve(networkID, signer);

    let approveTx;
    try {
        const gasPrice = await getGasPrice(provider);
        const bondAddr = bond.getAddressForBond(networkID);
        approveTx = await reserveContract.approve(bondAddr, constants.MaxUint256, { gasPrice });
        dispatch(
            fetchPendingTxns({
                txnHash: approveTx.hash,
                text: "Approving " + bond.displayName,
                type: "approve_" + bond.name,
            }),
        );
        await approveTx.wait();
        dispatch(success({ text: messages.tx_successfully_send }));
    } catch (err: any) {
        metamaskErrorWrap(err, dispatch);
    } finally {
        if (approveTx) {
            dispatch(clearPendingTxn(approveTx.hash));
        }
    }

    await sleep(2);

    let allowance = "0";

    allowance = await reserveContract.allowance(address, bond.getAddressForBond(networkID));

    return dispatch(
        fetchAccountSuccess({
            bonds: {
                [bond.name]: {
                    allowance: Number(allowance),
                },
            },
        }),
    );
});

export const changeSabApproval = createAsyncThunk("bonding/changeSabApproval", async ({ bond, provider, networkID, address }: IChangeApproval, { dispatch }) => {
    if (!provider) {
        dispatch(warning({ text: messages.please_connect_wallet }));
        return;
    }
    const addresses = getAddresses(networkID);

    const signer = provider.getSigner();
    const sabContract = new ethers.Contract(addresses.NORO_ADDRESS, SabTokenContract, signer);

    let approveTx;
    try {
        const gasPrice = await getGasPrice(provider);
        const bondAddr = bond.getAddressForBond(networkID);
        approveTx = await sabContract.approve(bondAddr, constants.MaxUint256, { gasPrice });

        const text = "Approve Sab";
        const pendingTxnType = "approve_sab";

        dispatch(fetchPendingTxns({ txnHash: approveTx.hash, text, type: pendingTxnType }));
        await approveTx.wait();
        dispatch(success({ text: messages.tx_successfully_send }));
    } catch (err: any) {
        return metamaskErrorWrap(err, dispatch);
    } finally {
        if (approveTx) {
            dispatch(clearPendingTxn(approveTx.hash));
        }
    }

    await sleep(2);

    const sabAllowance = await sabContract.allowance(address, bond.getAddressForBond(networkID));

    return dispatch(
        fetchAccountSuccess({
            bonds: {
                [bond.name]: {
                    allowanceSab: Number(sabAllowance),
                },
            },
        }),
    );
});

interface ICalcBondDetails {
    bond: IAllBondData;
    value: string | null;
    provider: StaticJsonRpcProvider | JsonRpcProvider;
    networkID: Networks;
}

export interface IBondDetails {
    bond: string;
    bondDiscount: number;
    bondQuote: number;
    purchased: number;
    vestingTerm: number;
    maxBondPrice: number;
    bondPrice: number;
    marketPrice: number;
    maxBondPriceToken: number;
}

export const calcBondDetails = createAsyncThunk("bonding/calcBondDetails", async ({ bond, value, provider, networkID }: ICalcBondDetails, { dispatch }) => {
    if (!value) {
        value = "0";
    }

    // const amountInWei = ethers.utils.parseEther(value);
    const amountInWei = parseInt(value) * Math.pow(10, bond.reserveDecimal);
    console.log(amountInWei);

    let bondPrice = 0,
        bondDiscount = 0,
        valuation = 0,
        bondQuote = 0;

    const addresses = getAddresses(networkID);

    const bondContract = bond.getContractForBond(networkID, provider);
    const bondCalcContract = getBondCalculator(networkID, provider);

    const terms = await bondContract.terms();
    const maxBondPrice = (await bondContract.maxPayout()) / Math.pow(10, 9);

    let marketPrice = await getMarketPrice(networkID, provider);

    // marketPrice = (marketPrice / Math.pow(10, 9)) * bendPrice;
    const avaxPrice = getTokenPrice("AVAX");
    const ethPrice = getTokenPrice("ETH");
    const bendPrice = getTokenPrice("BEND");
    let reserveDecimal = bond.reserveDecimal;

    try {
        bondPrice = await bondContract.bondPriceInUSD();

        // if (bond.name === avaxTime.name) {
        //     const avaxPrice = getTokenPrice("AVAX");
        //     bondPrice = bondPrice * avaxPrice;
        // }

        // bondDiscount = (marketPrice * Math.pow(10, reserveDecimal) - bondPrice) / (marketPrice * Math.pow(10, reserveDecimal));
        bondDiscount = 0.2;
    } catch (e) {
        console.log("error getting bondPriceInUSD", e);
    }

    let maxBondPriceToken = 0;
    const maxBodValue = ethers.utils.parseEther("1");
    let maxBondQuote = 0;

    if (bond.isLP) {
        valuation = await bondCalcContract.valuation(bond.getAddressForReserve(networkID), amountInWei);
        bondQuote = await bondContract.payoutFor(valuation);
        bondQuote = bondQuote / Math.pow(10, 9);

        const maxValuation = await bondCalcContract.valuation(bond.getAddressForReserve(networkID), maxBodValue);
        maxBondQuote = await bondContract.payoutFor(maxValuation);
        maxBondPriceToken = maxBondPrice / (maxBondQuote * Math.pow(10, -9));
    } else {
        bondQuote = await bondContract.payoutFor(amountInWei);
        console.log("payout-for", bondQuote);

        // bondQuote = bondQuote / Math.pow(10, 18);
        bondQuote = parseInt(value) * bendPrice;

        maxBondQuote = await bondContract.payoutFor(maxBodValue);
        // if (bond.name === wavax.name) {
        //     maxBondQuote = maxBondQuote * avaxPrice;
        // }
        maxBondPriceToken = maxBondPrice / (maxBondQuote * Math.pow(10, -18));

        // if (bond.name === wavax.name) {
        //     bondQuote = bondQuote * avaxPrice;
        // } else if (bond.name === bend.name) {
        //     bondQuote = bondQuote * 0.94 * 0.94 * bendPrice;
        // }
    }

    // Calculate bonds purchased
    const token = bond.getContractForReserve(networkID, provider);
    let purchased = await token.balanceOf(addresses.TREASURY_ADDRESS);

    if (bond.isLP) {
        const assetAddress = bond.getAddressForReserve(networkID);
        const markdown = await bondCalcContract.markdown(assetAddress);

        purchased = await bondCalcContract.valuation(assetAddress, purchased);
        purchased = (markdown / Math.pow(10, 18)) * (purchased / Math.pow(10, 9));

        // if (bond.name === avaxTime.name) {
        //     const avaxPrice = getTokenPrice("AVAX");
        //     purchased = purchased * avaxPrice;
        // }
    } else {
        if (bond.tokensInStrategy) {
            purchased = BigNumber.from(purchased).add(BigNumber.from(bond.tokensInStrategy)).toString();
        }
        purchased = purchased / Math.pow(10, reserveDecimal);

        // if (bond.name === wavax.name) {
        //     purchased = purchased * avaxPrice;
        // } else if (bond.name === bend.name) {
        //     purchased = purchased * bendPrice;
        // }
        purchased = purchased * bendPrice;
    }

    bondPrice = marketPrice;

    return {
        bond: bond.name,
        bondDiscount,
        bondQuote,
        purchased,
        vestingTerm: Number(terms.vestingTerm),
        maxBondPrice,
        bondPrice: bondPrice / Math.pow(10, reserveDecimal),
        marketPrice,
        maxBondPriceToken,
    };
});

export interface IBondWithdrawDetails {
    bond: string;
    bondDiscount: number;
    withdrawQuote: number;
    withdrawFee: number;
    maxWithdraw: number;
    bondPrice: number;
    marketPrice: number;
    purchased: number;
}

export const calcBondWithDrawDetails = createAsyncThunk("bonding/calcBondDetails", async ({ bond, value, provider, networkID }: ICalcBondDetails, { dispatch }) => {
    if (!value) {
        value = "0";
    }

    const amountInWei = parseInt(value) * Math.pow(10, bond.reserveDecimal);

    let bondPrice = 0,
        bondDiscount = 0,
        withdrawQuote = 0,
        withdrawFee = 0,
        maxWithdraw = 0;

    const addresses = getAddresses(networkID);

    const bondContract = bond.getContractForBond(networkID, provider);
    const bondCalcContract = getBondCalculator(networkID, provider);

    const terms = await bondContract.terms();

    let marketPrice = await getMarketPrice(networkID, provider);

    // const bendPrice = getTokenPrice("MIM");
    // marketPrice = (marketPrice / Math.pow(10, 9)) * bendPrice;
    const avaxPrice = getTokenPrice("AVAX");
    const ethPrice = getTokenPrice("ETH");
    const bendPrice = getTokenPrice("BEND");
    let reserveDecimal = bond.reserveDecimal;

    try {
        bondPrice = await bondContract.bondPriceInUSD();

        // if (bond.name === avaxTime.name) {
        //     const avaxPrice = getTokenPrice("AVAX");
        //     bondPrice = bondPrice * avaxPrice;
        // }

        bondDiscount = 0.2;
    } catch (e) {
        console.log("error getting bondPriceInUSD", e);
    }

    withdrawQuote = parseFloat(value) * (1 - bondDiscount);
    let withdrawInGwei = Number(amountInWei) / Math.pow(10, 18);

    // if (bond.name === wavax.name) {
    //     withdrawQuote = withdrawQuote / avaxPrice;
    // }

    withdrawFee = withdrawQuote * 0.1;
    withdrawQuote -= withdrawFee;

    maxWithdraw = bond.balanceSab * 0.1;

    if (!!value && withdrawInGwei > maxWithdraw) {
        dispatch(error({ text: messages.try_withdraw_more(maxWithdraw.toFixed(2).toString()) }));
    }

    // Calculate bonds purchased
    const token = bond.getContractForReserve(networkID, provider);
    let purchased = await token.balanceOf(addresses.TREASURY_ADDRESS);

    purchased = purchased * bendPrice;

    // if (bond.name === wavax.name) {
    //     purchased = purchased * avaxPrice;
    // }

    return {
        bond: bond.name,
        bondDiscount,
        withdrawQuote,
        withdrawFee,
        maxWithdraw,
        bondPrice: bondPrice / Math.pow(10, bond.reserveDecimal),
        marketPrice,
    };
});

interface IBondAsset {
    value: string;
    address: string;
    bond: IAllBondData;
    networkID: Networks;
    provider: StaticJsonRpcProvider | JsonRpcProvider;
    slippage: number;
    useAvax: boolean;
}
export const bondAsset = createAsyncThunk("bonding/bondAsset", async ({ value, address, bond, networkID, provider, slippage, useAvax }: IBondAsset, { dispatch }) => {
    const depositorAddress = address;
    const acceptedSlippage = slippage / 100 || 0.005;
    let valueInWei = ethers.utils.parseUnits(value, bond.reserveDecimal);
    console.log(valueInWei);

    const signer = provider.getSigner();
    const bondContract = bond.getContractForBond(networkID, signer);

    const calculatePremium = await bondContract.bondPrice();
    const maxPremium = Math.round(calculatePremium * (1 + acceptedSlippage));

    let bondTx;
    try {
        const gasPrice = await getGasPrice(provider);

        if (useAvax) {
            bondTx = await bondContract.deposit(valueInWei, maxPremium, depositorAddress, { value: valueInWei, gasPrice });
        } else {
            bondTx = await bondContract.deposit(valueInWei, maxPremium, depositorAddress, { gasPrice });
        }
        dispatch(
            fetchPendingTxns({
                txnHash: bondTx.hash,
                text: "Bonding " + bond.displayName,
                type: "bond_" + bond.name,
            }),
        );
        await bondTx.wait();
        dispatch(success({ text: messages.tx_successfully_send }));
        dispatch(info({ text: messages.your_balance_update_soon }));
        await sleep(10);
        await dispatch(calculateUserBondDetails({ address, bond, networkID, provider }));
        dispatch(info({ text: messages.your_balance_updated }));
        return;
    } catch (err: any) {
        return metamaskErrorWrap(err, dispatch);
    } finally {
        if (bondTx) {
            dispatch(clearPendingTxn(bondTx.hash));
        }
    }
});

export const bondWithdraw = createAsyncThunk("bonding/bondWithdraw", async ({ value, address, bond, networkID, provider, useAvax }: IBondAsset, { dispatch }) => {
    const withdrawAddress = address;
    const valueInGwei = ethers.utils.parseUnits(value, "gwei");
    const signer = provider.getSigner();
    const bondContract = bond.getContractForBond(networkID, signer);

    let bondWithdrawTx;
    try {
        const gasPrice = await getGasPrice(provider);

        bondWithdrawTx = await bondContract.withdraw(withdrawAddress, valueInGwei, { gasPrice });

        dispatch(
            fetchPendingTxns({
                txnHash: bondWithdrawTx.hash,
                text: "Withdrawing " + bond.displayName,
                type: "withdraw_bond_" + bond.name,
            }),
        );
        await bondWithdrawTx.wait();
        dispatch(success({ text: messages.tx_successfully_send }));
        dispatch(info({ text: messages.your_balance_update_soon }));
        await sleep(10);
        await dispatch(calculateUserBondDetails({ address, bond, networkID, provider }));
        dispatch(info({ text: messages.your_balance_updated }));
        return;
    } catch (err: any) {
        return metamaskErrorWrap(err, dispatch);
    } finally {
        if (bondWithdrawTx) {
            dispatch(clearPendingTxn(bondWithdrawTx.hash));
        }
    }
});

interface IRedeemBond {
    address: string;
    bond: Bond;
    networkID: Networks;
    provider: StaticJsonRpcProvider | JsonRpcProvider;
    autostake: boolean;
}

export const redeemBond = createAsyncThunk("bonding/redeemBond", async ({ address, bond, networkID, provider, autostake }: IRedeemBond, { dispatch }) => {
    if (!provider) {
        dispatch(warning({ text: messages.please_connect_wallet }));
        return;
    }

    const signer = provider.getSigner();
    const bondContract = bond.getContractForBond(networkID, signer);

    let redeemTx;
    try {
        const gasPrice = await getGasPrice(provider);

        redeemTx = await bondContract.redeem(address, autostake === true, { gasPrice });
        const pendingTxnType = "redeem_bond_" + bond.name + (autostake === true ? "_autostake" : "");
        dispatch(
            fetchPendingTxns({
                txnHash: redeemTx.hash,
                text: "Redeeming " + bond.displayName,
                type: pendingTxnType,
            }),
        );
        await redeemTx.wait();
        dispatch(success({ text: messages.tx_successfully_send }));
        await sleep(0.01);
        dispatch(info({ text: messages.your_balance_update_soon }));
        await sleep(10);
        await dispatch(calculateUserBondDetails({ address, bond, networkID, provider }));
        await dispatch(getBalances({ address, networkID, provider }));
        dispatch(info({ text: messages.your_balance_updated }));
        return;
    } catch (err: any) {
        metamaskErrorWrap(err, dispatch);
    } finally {
        if (redeemTx) {
            dispatch(clearPendingTxn(redeemTx.hash));
        }
    }
});

export interface IBondSlice {
    loading: boolean;
    [key: string]: any;
}

const initialState: IBondSlice = {
    loading: true,
};

const setBondState = (state: IBondSlice, payload: any) => {
    const bond = payload.bond;
    const newState = { ...state[bond], ...payload };
    state[bond] = newState;
    state.loading = false;
};

const bondingSlice = createSlice({
    name: "bonding",
    initialState,
    reducers: {
        fetchBondSuccess(state, action) {
            state[action.payload.bond] = action.payload;
        },
    },
    extraReducers: builder => {
        builder
            .addCase(calcBondDetails.pending, state => {
                state.loading = true;
            })
            .addCase(calcBondDetails.fulfilled, (state, action) => {
                setBondState(state, action.payload);
                state.loading = false;
            })
            .addCase(calcBondDetails.rejected, (state, { error }) => {
                state.loading = false;
                console.log(error);
            });
    },
});

export default bondingSlice.reducer;

export const { fetchBondSuccess } = bondingSlice.actions;

const baseInfo = (state: RootState) => state.bonding;

export const getBondingState = createSelector(baseInfo, bonding => bonding);
