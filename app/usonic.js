'use strict';

//const ut = require('./inc/utils.js');

const { exec } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const prom = require('util').promisify;
const fsReadDir = prom(fs.readdir);
const fsReadFile = prom(fs.readFile);
const fsWriteFile = prom(fs.writeFile);


let logCtx = null, log = null;
let rpc = null, cfg = null;

const SPI_SPEED = 1000_000;

let isEmu = false;
let usSpi = null;
let spiBusy = false;

const RETR_CNT = 16;
const CHUNK_SIZE = 4096;	

let US_CMD = {
	GET_NAME: 1,		// 0x01 Возвращает char[80] 0-терминированную строку
	GET_IO: 2,			// 0x02 Возвращает io_state_t
	SET_OUT: 3,			// 0x03 Параметры: (uint8_t out, uint8_t state)
						//  номер пина (0-4) и состояние (0-1)
	ONE_SHOT: 4,		// 0x04 Произвести ультразвоковое измерение,
						//	возвращает uint16_t[US_BUF_LEN] данные измерения
	LAST_ERR: 5,		// текст сообщения о последней ошибке
	LIBUS_FUNC: 6		// вызвать функцию рассчета из библиотеки алгоритмов
};

function sleep(ms) {
	return new Promise(res => setTimeout(res, ms));
}

function fsExist(fPath) {
	return new Promise(res => {
		fs.access(fPath, fs.F_OK, err => {
			if (err) res(false);
			else res(true);
		});
	});
}

async function takeSpi() {
	//log('take start');
	while (spiBusy) await sleep(10);
	
	//log('take on');
	spiBusy = true;
}

function releaseSpi() {
	//log('release');
	spiBusy = false;
}

function crtEmuApi() {
	const IO_SIZE = 7;
	let bufIo = Buffer.alloc(IO_SIZE);
	
	const SIG_SIZE = 0x1C00;
	let bufSig = Buffer.alloc(SIG_SIZE);
	
	let bufFunc = Buffer.alloc(4 * 8);
	
	let retBuf = null;
	
	function crtSize(size) {
		let ret = Buffer.alloc(4);
		let invSize = (~size & 0xFFFF)
		
		ret[0] = size & 0xFF;
		ret[1] = size >> 8;
		ret[2] = invSize & 0xFF;
		ret[3] = invSize >> 8;
		
		return ret;
	}
	
	function write(data) {
		//log('emuWrite', data);
		let cmd = data.shift();
		
		switch (cmd) {
		case US_CMD.GET_NAME:
			//
			break;
		case US_CMD.GET_IO:
			retBuf = Buffer.concat([ crtSize(IO_SIZE), bufIo ]);
			break;
		case US_CMD.SET_OUT:
			
			let outNum = data.shift() + 2;
			let state = data.shift();
			
			if (state) bufIo[6] |= 1 << outNum;
			else bufIo[6] &= ~(1 << outNum);
			
			break;
		case US_CMD.ONE_SHOT:
			retBuf = Buffer.concat([ crtSize(SIG_SIZE), bufSig ]);
			break;
		case US_CMD.LIBUS_FUNC:
			let funcNum = data.shift();
			
			retBuf = Buffer.concat([ crtSize(8), bufFunc.slice(funcNum * 8, funcNum * 8 + 8) ]);
			
			break;
		default:
			log('Unknown cmd:', cmd, data);
		}
	}

	function read(len) {
		//log('emuRead', len);
		
		let ret = retBuf.slice(0, len);
		retBuf = retBuf.slice(len);
		
		return ret;
	}
	
	async function rndLoop() {
		const AI_RND = 100;
		
		bufFunc.writeUInt16LE(777, 0);
		bufFunc.writeDoubleLE(5, 8);
		bufFunc.writeDoubleLE(5, 16);
		bufFunc.writeDoubleLE(5, 24);
		
		while (true) {
			let v;
			
			for (let i = 0; i < 5; i += 2) {
				let v = bufIo.readUInt16LE(i);
				
				v += Math.random() * AI_RND - AI_RND / 2;
				
				if (v < 0) v = 0;
				if (v > 0xFFFF) v = 0xFFFF;
				
				bufIo.writeUInt16LE(v, i);
			}
			
			const SIG_RND = 20;
			let sigVal = 511;
			for (let i = 0; i < SIG_SIZE; i += 2) {
				
				if (i > 1000) {
					sigVal +=  Math.random() * SIG_RND - SIG_RND / 2;
					if (sigVal < 0) sigVal = 0;
					if (sigVal > 1023) sigVal = 1023;
				}
				
				bufSig.writeUInt16LE(sigVal, i);
			}
			
			const FUNC_RND = 2;
			for (let i = 8; i < 4 * 8; i += 8) {
				let v = bufFunc.readDoubleLE(i);
				
				v += Math.random() * FUNC_RND - FUNC_RND / 2;
				
				if (v < 0) v = 0;
				
				bufFunc.writeDoubleLE(v, i);
			}
			
			
			await sleep(500);
		}
	}
	
	rndLoop();
	
	return { write, read };
}

function openSpi(busNum, devNum) {
	
	if (isEmu) {
		return crtEmuApi();
	} else {
		const spi = require('spi-device');
		
		return new Promise(res => {
			let ctx = spi.open(busNum, devNum, err => {
				if (err) throw err;
				
				let ret = {};
				
				ret.ctx = ctx;
				
				ret.write = (data) => spiWrite(ctx, data);
				ret.read = (len) => spiRead(ctx, len);
				
				res(ret);
			});
		});
	}
}

function spiReq(ctx, sendData, recData) {
	return new Promise(res => {
		let msg = [ {
			sendBuffer: sendData,
			receiveBuffer: recData,
			byteLength: sendData.length,
			speedHz: SPI_SPEED
		} ];
		
		ctx.transfer(msg, (err, msg) => {
			if (err) throw err;
			
			//log('MSG', msg);
			res(msg[0].receiveBuffer);
		});
	});
}

async function spiWrite(ctx, data) {
	//log('spiWrite', data);
	await spiReq(ctx, Buffer.from(data), Buffer.alloc(data.length));
}

async function spiRead(ctx, len) {
	//log('spiRead', len);
	let res = await spiReq(ctx, Buffer.alloc(len), Buffer.alloc(len));
	return res;
}

function decodeSize(d) {
	let a = d[0] + (d[1] << 8);
	let b = d[2] + (d[3] << 8);
	
	//log('a, b', a, b, ~b & 0xFFFF);
	if (a == (~b & 0xFFFF)) return a;
	return null;
}

async function usReq(cmd, args = [], needResp = true) {
	const DELAY = 1;
	
	await takeSpi();
	
	let reqData = [ cmd, ...args ];
	await usSpi.write(reqData);
	await sleep(DELAY);
	
	if (!needResp) {
		await releaseSpi();
		return;
	}
	
	let size = null;
	for (let i = 0; i < RETR_CNT; i++) {
		let res = await usSpi.read(4);
		size = decodeSize(res);
		
		//log('res', res, size);
		if (size) break;
		
		await sleep(DELAY);
	}
	
	if (!size) {
		logCtx.logError('No responce size');
		await releaseSpi();
		return null;
	}
	
	let respData = Buffer.from([]);
	
	while (size) {
		let readCnt = 0;
		
		if (size >= CHUNK_SIZE) {
			readCnt = CHUNK_SIZE;
			size = size - CHUNK_SIZE;
		} else {
			readCnt = size;
			size = 0;
		}
		
		let res = await usSpi.read(readCnt);
		
		respData = Buffer.concat([ respData, res ]);
	}
	
	await sleep(DELAY);
	
	//return [ ...respData ];
	
	await releaseSpi();
	
	return respData;
}

async function getSignal() {
	let res = await usReq(US_CMD.ONE_SHOT, [], true);
	
	let ret = [];
	for (let i = 0; i < res.length; i += 2) {
		ret.push(res.readUInt16LE(i));
	}
	
	//log('ret', ret.length, ret.splice(0, 32));
	
	return ret;
}

async function getInfo() {
	let res = await usReq(US_CMD.GET_NAME, [], true);
	
	return {
		model: res.readUInt16LE(0),
		revision: res.readUInt16LE(2),
		fwVer: res.readUInt16LE(4)
	};
}

const ioFiltSize = 8;
let ioArVal = [];
async function getIoState() {
	//log('getIoState');
	let res = await usReq(US_CMD.GET_IO, [], true);
	
	if (!res) return null;
	
	let d = {
		ai: {
			temp1: res.readUInt16LE(0) >> 3,
			temp2: res.readUInt16LE(2) >> 3,
			press: res.readUInt16LE(4)
		},
		di: {
			water: Boolean((res[6] >> 0) & 1),
			reserv: Boolean((res[6] >> 1) & 1)
		},
		'do': {
			cool: Boolean((res[6] >> 2) & 1),
			air: Boolean((res[6] >> 3) & 1),
			water: Boolean((res[6] >> 4) & 1),
			heat: Boolean((res[6] >> 5) & 1),
			reserv: Boolean((res[6] >> 6) & 1)
		}
	};
	
	ioArVal.push(d);
	
	if (ioArVal.length > ioFiltSize) ioArVal.shift();
	
	let fd = {
		temp1: 0,
		temp2: 0,
		press: 0
	};
	
	for (let v of ioArVal) {
		for (let key in fd) {
			
			fd[key] += v.ai[key];
		}
	}
	
	for (let key in fd) {
		fd[key] /= ioArVal.length;
	}
	
	let ret = {
		ai: {
			temp1: fd.temp1,
			temp2: fd.temp2,
			press: fd.press
		},
		di: {
			water: d.di.water,
			reserv: d.di.reserv
		},
		'do': {
			cool: d.do.cool,
			air: d.do.air,
			water: d.do.water,
			heat: d.do.heat,
			reserv: d.do.reserv
		}
	};
	
	return ret;
}

async function setOutState(name, state) {
	let doNum = null;
	
	switch (name) {
	case 'cool':
		doNum = 0;
		break;
	case 'air':
		doNum = 1;
		break;
	case 'water':
		doNum = 2;
		break;
	case 'heat':
		doNum = 3;
		break;
	case 'reserv':
		doNum = 4;
		break;
	}
	
	if (doNum === null) {
		logCtx.logError('Invalid name:', name);
		return;
	}
	
	await usReq(US_CMD.SET_OUT, [ doNum, state ? 1 : 0 ], false);
}

async function getError() {
	let res = await usReq(US_CMD.LAST_ERR, [], true);
	let sRes = res.toString().split(' ');
	
	return {
		curStamp: parseInt(sRes.shift()),
		errStamp: parseInt(sRes.shift()),
		msg: sRes.join(' ')
	};
}

async function getLibVer() {
	let res = await usReq(US_CMD.LIBUS_FUNC, [ 0 ], true);
	
	return res.readUInt16LE(0);
}


//double calculateStrength(double timeSignal, int weightNumber);
async function calcStren(time, wNum) {
	let arg = Buffer.alloc(12);
	
	arg.writeDoubleLE(time, 0); // + 8
	arg.writeInt32LE(wNum, 8); // + 4
	
	let res = await usReq(US_CMD.LIBUS_FUNC, [ 1, ...arg ], true);
	
	//log('res', [ 0, ...arg ], res);
	
	return res.readDoubleLE(0);
}

//double calculateSgs(int pointState,
//	int amplitudePoint, double amplitude,
//	int minAmplitudePoint, double minAmplitude,
//	int maxAcceleratePoint, double maxAccelerate);
async function calcSgs(st, ampPos, amp, minAmpPos, minAmp, maxAccPos, maxAcc) {
	let arg = Buffer.alloc(40);
	
	arg.writeInt32LE(st, 0); // + 4
	arg.writeInt32LE(ampPos, 4); // + 4
	arg.writeDoubleLE(amp, 8); // + 8
	arg.writeInt32LE(minAmpPos, 16); // + 4
	arg.writeDoubleLE(minAmp, 20); // + 8
	arg.writeInt32LE(maxAccPos, 28); // + 4
	arg.writeDoubleLE(maxAcc, 32); // + 8
	
	let res = await usReq(US_CMD.LIBUS_FUNC, [ 2, ...arg ], true);
	
	return res.readDoubleLE(0);
}

//double calculateAcousticImpedance(double timeSignal, double density);
async function calcImp(time, dens) {
	let arg = Buffer.alloc(16);
	
	arg.writeDoubleLE(time, 0); // + 8
	arg.writeDoubleLE(dens, 8); // + 8
	
	let res = await usReq(US_CMD.LIBUS_FUNC, [ 3, ...arg ], true);
	
	return res.readDoubleLE(0);
}

async function getFwList(fwPath) {
	let ret = [];
	
	fwPath += path.sep
	let fileList = await fsReadDir(fwPath);
	
	for (let fName of fileList) {
		
		let [ name, ext ] = fName.split('.');
		
		if (!ext) continue;
		if (ext.toLowerCase() != 'bin') continue;
		
		ret.push(fwPath + fName);
	}
	
	return ret;
}

function sysExec(cmd) {
	return new Promise(res => {
		exec(cmd, (err, stdOut, stdErr) => {
			if (err) {
				res('');
				return;
			}
			
			res(stdOut);
		});
	});
}

async function writeFw(filePath) {
	// stm32flash -w io_board_H503CBT6_v1.0.bin -v -i '147&-22,22:-147&-22,,,22' /dev/ttyS7 -b 115200
	
	let cmd = 'stm32flash -w "' + filePath + '" -v -i "147&-22,22:-147&-22,,,22" /dev/ttyS7 -b 115200';
	return await sysExec(cmd);
}

async function getLogo(logoPath) {
	logoPath += path.sep + 'logo.png';
	
	if (!(await fsExist(logoPath))) return null;
	
	let ret = 'data:image/png;base64,' + (await fsReadFile(logoPath)).toString('base64');
	
	return ret;
}

const REP_TML = `
<!DOCTYPE html>
<html lang="ru">
<head>
	<meta charset="UTF-8">
</head>
<body>
	<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; color: #008800;">
		<div style="text-align: left;">
		 __INFO_UL__
		</div>
		<div style="text-align: center;">
		 __INFO_UC__
		</div>
		<div style="text-align: right;">
		 __INFO_UR__
		</div>
	</div>
	<br>
	<img src="__IMG__"><br>
	<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; color: #008800;">
		<div style="text-align: left;">
			<img src="__LOGO__"><br>
		</div>
		<div style="text-align: center;">
		 __INFO_DC__
		</div>
		<div style="text-align: right;">
		 __INFO_DR__
		</div>
	</div>
</body>
</html>
`;

let repWin = null, fRepWinReady = null;
async function savePdf(fPath, htmlPage) {
	
	function crtRepWin() {
		const { BrowserWindow } = require('electron');
		
		let win = new BrowserWindow({
			webPreferences: {
				nativeWindowOpen: true
			},
			width: 850,
			height: 650,
			icon: path.join(__dirname, '..') + '/img/logo_256.png',
			show: false
		});
		
		win.setMenu(null);
		
		win.on('ready-to-show', () => {
			if (fRepWinReady) fRepWinReady();
		});
		
		return win;
	}
	
	if (!repWin) repWin = await crtRepWin();
	
	return new Promise(res => {
		fRepWinReady = async () => {
			let opt = {
				marginsType: 0,
				pageSize: 'A4',
				printBackground: true,
				printSelectionOnly: false,
				landscape: true
			}
			
			let bufPdf = await repWin.webContents.printToPDF(opt);
			
			await fsWriteFile(fPath, bufPdf);
			
			res();
		};
		
		let page64 = Buffer.from(htmlPage).toString('base64');
		repWin.loadURL('data:text/html;base64,' + page64);
	});
}

async function saveReport(d) {
	
	const { Jimp } = require('jimp');
	
	log('saveReport', d);
	
	let fPath = d.fPath + path.sep + d.name;
	
	if (isEmu) fPath = 'c:\\tmp\\' + d.name;
	
	// save img
	
	let b64Img = d.img.split(',')[1];
	let bufImg = Buffer.from(b64Img, 'base64');
	let img = await Jimp.fromBuffer(bufImg);
	
	if (d.logo) {
		let b64logo = d.logo.split(',')[1];
		let bufLogo = Buffer.from(b64logo, 'base64');
		let logo = await Jimp.fromBuffer(bufLogo);
		
		img.composite(logo, 300, 30);
	}
	
	await img.write(fPath + '.png');
	
	// save table
	
	let csv = '\ufeffВремя;Температура;Давление;Прочность;SGS;Аккустический импеданс\n';
	
	for (let pd of d.pointList) {
		let row = [];
		//row.push(pd.time);
		row.push(pd.timeSec);
		row.push(pd.temp);
		row.push(pd.press);
		row.push(pd.stren);
		row.push(pd.sgs);
		row.push(pd.imp);
		
		csv += row.join(';') + '\n';
	}
	
	await fsWriteFile(fPath + '.csv', csv);
	
	// save pdf
	
	let page = REP_TML;
	
	let modeStr = '';
	switch (d.mode) {
	case 0:
		modeStr = 'не выбран';
		break;
	case 1:
		modeStr = 'легкий';
		break;
	case 2:
		modeStr = 'нормальный';
		break;
	case 3:
		modeStr = 'тяжелый';
		break;
	}
	
	let infoUL = [];
	infoUL.push('Номер испытания: ' + d.name);
	infoUL.push('Куст: ' + d.kust);
	infoUL.push('Скважина: ' + d.skva);
	infoUL.push('Заказчик: ' + d.zak);
	infoUL.push('Месторождение: ' + d.mest);
	infoUL.push('Коментарии: ' + d.comment);
	
	let infoUC = [];
	infoUC.push('Время начала: ' + (new Date(d.timeStart * 1000)).toString('dd.MM.yyyy HH:mm:ss'));
	infoUC.push('Время завершения: ' + (new Date(d.timeFinish * 1000)).toString('dd.MM.yyyy HH:mm:ss'));
	infoUC.push('Плотность раствора: ' + d.plot);
	infoUC.push('Режим: ' + modeStr);
	
	let tz = (new Date()).getTimezoneOffset() * 60000;
	
	//log('ev', d.evTab, d.evData);
	let stren = '';
	for (let i = 1; i <= 4; i++) {
		let v = d.evTab['time' + i].key;
		
		if (v) v = (new Date(v + tz)).toString('HH:mm:ss');
		else v = '00:00:00';
		
		stren += 'Время ' + v;
		
		//v = d.evData['timeStren' + i];
		v = d.evTab['time' + i].val[d.mode - 1];
		
		if (v) v = parseInt(v);
		else v = 0;
		
		stren += ', прочность ' + v;
		stren += '<br>';
	}
	
	stren += '<br>';
	
	for (let i = 1; i <= 4; i++) {
		let v = d.evTab['stren' + i].key;
		
		if (v) v = parseInt(v);
		else v = 0;
		
		stren += 'Прочность ' + v;
		
		v = d.evTab['stren' + i].val[d.mode - 1];
		
		if (v) v = (new Date(v + tz)).toString('HH:mm:ss');
		else v = '00:00:00';
		
		stren += ', время ' + v;
		stren += '<br>';
	}
	
	page = page.replace('__IMG__', d.img);
	page = page.replace('__LOGO__', d.logo);
	
	page = page.replace('__INFO_UL__', infoUL.join('<br>'));
	page = page.replace('__INFO_UC__', infoUC.join('<br>'));
	page = page.replace('__INFO_UR__', stren);
	
	page = page.replace('__INFO_DC__', 'Название файла: ' + d.name);
	page = page.replace('__INFO_DR__', 'Фамилия оператора: ' + d.oper);
	
	//await fsWriteFile(fPath + '.html', page);
	await savePdf(fPath + '.pdf', page);
}

async function main(ctx) {
	
	({ logCtx, rpc, cfg } = ctx);
	({ log } = logCtx);
	module.paths.push(ctx.modPath);
	
	require('datejs');
	
	logCtx.logInfo('Usonic sarted, platform:', cfg.platform.name);
	
	if (cfg.platform.name == 'win32') {
		isEmu = true;
		log('Emulation enabled');
	}
	
	usSpi = await openSpi(3, 0);
	
	//await oneShot();
	
	rpc.regFunc('getInfo', getInfo);
	rpc.regFunc('getSignal', getSignal);
	rpc.regFunc('getIoState', getIoState);
	rpc.regFunc('setOutState', setOutState);
	rpc.regFunc('getError', getError);
	rpc.regFunc('getLibVer', getLibVer);
	rpc.regFunc('calcStren', calcStren);
	rpc.regFunc('calcSgs', calcSgs);
	rpc.regFunc('calcImp', calcImp);
	
	rpc.regFunc('getFwList', getFwList);
	rpc.regFunc('writeFw', writeFw);
	
	rpc.regFunc('getLogo', getLogo);
	rpc.regFunc('saveReport', saveReport);
	
	//await getSignal();
	
	//log('extInfo', await getInfo());
	//log('getSignal', await getSignal());
	
	//await setOutState('water', true);
	//log('getIoState', await getIoState());
	
	//log ('getError', await getError());
	
	//log('getLibVer', await getLibVer());
	
	//log('calcStren', await calcStren(1, 2));
	//log('calcSgs', await calcSgs(1, 2, 3, 4, 5, 6, 7));
	//log('calcImp', await calcImp(10, 20));
}

exports.main = main;

exports.about = {
	mark: 'US',
	descr: 'Модуль usonic',
	isSingle: true,
	isGui: false,
	isPm: false,
	order: 100,
	depend: []
};









