/* ---------- helper: instr generation & render ---------- */
function generateInstructions(total, brPct, lpPct){
    const loops=Math.round(total*lpPct/100), branches=Math.round(total*brPct/100);
    const others=total-loops-branches, seq=[...Array(others).fill('other'),...Array(branches).fill('branch'),...Array(loops).fill('loop')];
    seq.sort(()=>Math.random()-0.5);
    const instr=[];let pc=0x100;
    seq.forEach(t=>{
      if(t==='other'){
          instr.push({pc,type:'other'});
          pc+=4
      }
      else if(t==='branch'){
          instr.push({pc,type:'branch',target:pc+8,taken:Math.random()<0.5});
          pc+=4
      }
      else{
          instr.push({pc,type:'branch',target:pc,taken:[true,true,true,false]});
          pc+=4
      }
      });
    return instr;
  }
  
  function renderInstructions(arr){
      document.getElementById('instrPre').textContent=arr.map(i=>i.type==='other'?`0x${i.pc.toString(16)}: OTHER`:`0x${i.pc.toString(16)}: BRANCH -> 0x${i.target.toString(16)}, taken=${Array.isArray(i.taken)?i.taken.join(','):i.taken}`).join('\n');
  }
  
  /* ---------- predictors ---------- */
class TwoBitPredictor{
    /**
     * Создаёт 2-bit предсказатель - таблицу BHT.
     * @param {number} n Размер таблицы (количество слотов). Должно быть >= 1 и <= 1000 (или любой разумный предел).
     */
    constructor(n=32){
        this.size=n;
        this.bht=Array(n).fill(2);
    }
    index(pc){
        return (pc>>>2) % this.size
    }
    predict(pc){
        const idx=this.index(pc), value=this.bht[idx];
        return{predictTaken:value>=2, idx:idx}
    }
    update(pc, real) {
        const idx=this.index(pc);
        this.bht[idx]=real?Math.min(3, this.bht[idx]+1):Math.max(0, this.bht[idx]-1);
    }
}
  
class GSharePredictor{
    /**
     * Создаёт GShare предсказатель заданной длины.
     * @param {number} M - Длина регистра истории (количество бит).
     * @param {number} K - Размер таблицы PHT.
     */
    constructor(M=10, K=10) {
        this.M=M;
        this.K=K;       // PC bits (сколько адресных бит идёт в индекс)
        this.size=1<<K; // размер PHT = 2^K
        this.PHT=Array(this.size).fill(2);
        this.GHR=0;
    }
      index(pc){
        let pcPart = (pc >> 2) & (this.size - 1);
        let histPart = this.GHR & (this.size - 1);  // из M-битной GHR «свёртываем» в K бит
        let idx = pcPart ^ histPart;                // m = K, размер PHT = 2^K
        return(idx)
      }
      predict(pc){
          const i=this.index(pc), c=this.PHT[i];
          return{predictTaken:c >= 2, idx: i}
      }
      update(pc,t){
          const i=this.index(pc);
          this.PHT[i] = t ? Math.min(3, this.PHT[i] + 1) : Math.max(0, this.PHT[i] - 1);
          this.GHR=((this.GHR<<1) | (t ? 1 : 0)) & ((1<<this.M)-1)
      }
  }
  
  /* ---------- perceptron ---------- */
class PerceptronPredictor {
    constructor(H=24, N=163) {
        this.H=H;
        this.N=N;
        this.THRESHOLD=Math.round(1.93 * H + 14);
        this.weights=Array.from({length:N}, ()=>Array(H+1).fill(0));
        this.hist=Array(H).fill(false);
        this.lastOutput=0
    }
    index(pc){
        return(pc>>>2)%this.N
    }
    _dot(w){
        return w[0]+this.hist.reduce((s,b,i)=>s+w[i+1]*(b?1:-1),0)
    }
    predict(pc){
        const i=this.index(pc),out=this._dot(this.weights[i]);
        this.lastOutput=out;
        return {predictTaken:out>=0, idx:i, output:out}
    }
    update(pc,taken){
        const i=this.index(pc), w=this.weights[i];
        const y=taken?1:-1;
        const predicted = this.lastOutput >= 0;
        if ((predicted !== taken) || Math.abs(this.lastOutput) < this.THRESHOLD) {
            w[0]=this._clip(w[0]+y);
            for(let j=0;j<this.H;j++) {
                w[j+1]=this._clip(w[j+1]+y*(this.hist[j]?1:-1));
            }
        }
        this.hist.shift();
        this.hist.push(taken)
    }
      _clip(v){
          return Math.max(-128, Math.min(127,v))
      }
      getWeights(pc){
          return[...this.weights[this.index(pc)]]
      }
}

//Вспомогательный класс для TAGE
class GHRBits {
    /**
     * Создаёт GHR заданной длины.
     * @param {number} length Длина регистра истории (количество бит). Должно быть >= 1 и <= 1000 (или любой разумный предел).
     */
    constructor(length) {
      this.length = length;
      // Маска для обрезки старших битов (length младших бит = 1)
      // BigInt позволяет сдвигать на произвольную длину
      this.mask = (BigInt(1) << BigInt(length)) - BigInt(1);
      // Хранится как BigInt, изначально все биты = 0
      this.value = BigInt(0);
    }
  
    /**
     * Обновляет GHR: сдвигает влево на 1 и вставляет новый бит taken (0 или 1) в младший разряд.
     * @param {0|1} taken Результат ветвления: 1 = TAKEN, 0 = NOT TAKEN.
     */
    upd(taken) {
      const bit = taken ? BigInt(1) : BigInt(0);
      // Сдвиг влево + вставка нового бита + обрезка до нужной длины
      this.value = ((this.value << BigInt(1)) | bit) & this.mask;
    }
  
    /**
     * Возвращает бит истории k шагов назад.
     * @param {number} k Индекс бита (0 = самый свежий/младший, length-1 = самый старый).
     * @returns {0|1}
     */
    getBit(k) {
      if (!Number.isInteger(k) || k < 0 || k >= this.length) {
        return 0;
      }
      return Number((this.value >> BigInt(k)) & BigInt(1));
    }
  
    /**
     * Сбрасывает весь регистр истории в 0.
     */
    reset() {
      this.value = BigInt(0);
    }
      /**
   * Возвращает строковое представление GHR – двоичное, с ведущими нулями до длины length.
   * Полезно для отладки.
   * @returns {string}
   */
  toString() {
    let bin = this.value.toString(2);
    if (bin.length < this.length) {
      bin = bin.padStart(this.length, '0');
    }
    return bin;
  }
}

// Structure definitions
class CircularShiftRegister {
    constructor() {
        this.val = 0;
        this.oldlen = 0;
        this.newlen = 0;
    }
}

class BimodVal {
    constructor() {
        this.pred = 0;
    }
}

class TagVal {
    constructor() {
        this.pred = 0;
        this.tag = 0;
        this.u = 0;
    }

    reset() {
        this.pred = 0;
        this.tag = 0;
        this.u = 0;
    }
}

// Constants for TAGE
const TAKEN = 1;
const NOT_TAKEN = 0;

const BIMODAL_SIZE = 13;
const BIMODAL_PRED_MAX = 3;
const TAGE_PRED_MAX = 7;
const PRED_U_MAX = 3;
const BIMODAL_PRED_INIT = 2;

const WEAKLY_TAKEN = 4;
const WEAKLY_NOT_TAKEN = 3;

const NUM_TAGE_TABLES = 16;
const ALTPRED_BET_MAX = 15;
const ALTPRED_BET_INIT = 8;
const PHR_LEN = 16;
const CLOCK_MAX = 20;

// Tuned parameters
const HIST = [2, 3, 8, 12, 17, 33, 35, 67, 97, 138, 195, 330, 517, 1193, 1741, 1930];
const TAGE_TABLE_SIZE = [9, 9, 10, 10, 10, 10, 11, 11, 11, 11, 12, 12, 11, 11, 10, 10];
const TAGE_TAG_SIZE = [16, 15, 14, 14, 13, 13, 12, 12, 11, 10, 9, 9, 9, 8, 8, 7];

class TAGEPredictor{
    constructor() {
        this.initialize();
    }

    initialize() {
        // Global History Register
        this.GHR = new GHRBits(512);
        this.PHR = 0; // Path History Register

        // Initialize table sizes and tag sizes
        this.tageTableSize = [...TAGE_TABLE_SIZE];
        this.tageTagSize = [...TAGE_TAG_SIZE];

        // Initialize TAGE tables
        this.tagTables = [];
        for (let i = 0; i < NUM_TAGE_TABLES; i++) {
            const tableSize = 1 << this.tageTableSize[i];
            this.tagTables[i] = [];
            for (let j = 0; j < tableSize; j++) {
                this.tagTables[i][j] = new TagVal();
            }
        }

        // Initialize history lengths
        this.tageHistory = [];
        for (let i = 0; i < NUM_TAGE_TABLES; i++) {
            this.tageHistory[i] = HIST[NUM_TAGE_TABLES - 1 - i];
        }

        // Initialize index and tag arrays
        this.tageIndex = new Array(NUM_TAGE_TABLES).fill(0);
        this.tageTag = new Array(NUM_TAGE_TABLES).fill(0);

        // Initialize bimodal table
        this.numBimodalEntries = 1 << BIMODAL_SIZE;
        this.bimodal = [];
        for (let i = 0; i < this.numBimodalEntries; i++) {
            this.bimodal[i] = new BimodVal();
            this.bimodal[i].pred = BIMODAL_PRED_INIT;
        }

        // Initialize Circular Shift Registers
        this.csrIndex = [];
        this.csrTag = [[], []];
        
        for (let i = 0; i < NUM_TAGE_TABLES; i++) {
            this.csrIndex[i] = new CircularShiftRegister();
            this.csrIndex[i].val = 0;
            this.csrIndex[i].oldlen = this.tageHistory[i];
            this.csrIndex[i].newlen = this.tageTagSize[i];

            this.csrTag[0][i] = new CircularShiftRegister();
            this.csrTag[0][i].val = 0;
            this.csrTag[0][i].oldlen = this.tageHistory[i];
            this.csrTag[0][i].newlen = this.tageTagSize[i];

            this.csrTag[1][i] = new CircularShiftRegister();
            this.csrTag[1][i].val = 0;
            this.csrTag[1][i].oldlen = this.tageHistory[i];
            this.csrTag[1][i].newlen = this.tageTagSize[i] - 1;
        }

        // Initialize prediction variables
        this.pred_pred = false;
        this.altPred_pred = false;
        this.table_pred = NUM_TAGE_TABLES;
        this.altTable_pred = NUM_TAGE_TABLES;
        this.index_pred = 0;
        this.altIndex_pred = 0;

        // Initialize clock and state
        this.clockk = 0;
        this.clockState = 0;

        // Initialize other variables
        this.altBetterCount = ALTPRED_BET_INIT;
        this.predDir = 0;

        // Counters for table accesses
        this.tableAccessCount = new Array(NUM_TAGE_TABLES).fill(0);
        this.bimodalAccessCount = 0;
    }

    predict(PC) {
        const bimodalIndex = (PC >>> 2) % this.numBimodalEntries;

        // Get TAGE Tags
        for (let i = 0; i < NUM_TAGE_TABLES; i++) {
            const shifted = (this.csrTag[1][i].val << 1) & ((1 << this.tageTagSize[i]) - 1);
            this.tageTag[i] = (PC ^ this.csrTag[0][i].val ^ shifted) 
                                & ((1 << this.tageTagSize[i]) - 1);
            //this.tageTag[i] = (PC ^ this.csrTag[0][i].val ^ (this.csrTag[1][i].val << 1)) & 
            //                  ((1 << this.tageTagSize[i]) - 1);
        }

        // Get TAGE Indices
        //const offset = new Array(17).fill(0);
        for (let i = 0; i < NUM_TAGE_TABLES; i++) {
            this.tageIndex[i] = (PC ^ (PC >> this.tageTableSize[i]) ^ this.csrIndex[i].val ^ 
                                this.PHR ^ this.PHR) & 
                               ((1 << this.tageTableSize[i]) - 1);
        }

        // Reset prediction variables
        this.pred_pred = false;
        this.altPred_pred = false;
        this.table_pred = NUM_TAGE_TABLES;
        this.altTable_pred = NUM_TAGE_TABLES;

        // Find first matching TAGE table
        for (let i = 0; i < NUM_TAGE_TABLES; i++) {
            if (this.tagTables[i][this.tageIndex[i]].tag === this.tageTag[i]) {
                this.table_pred = i;
                this.index_pred = this.tageIndex[i];
                break;
            }
        }

        // Find alternate table with longer history
        for (let i = this.table_pred + 1; i < NUM_TAGE_TABLES; i++) {
            if (this.tagTables[i][this.tageIndex[i]].tag === this.tageTag[i]) {
                this.altTable_pred = i;
                this.altIndex_pred = this.tageIndex[i];
                break;
            }
        }

         // Count which table is used for prediction
         if (this.table_pred < NUM_TAGE_TABLES) {
            this.tableAccessCount[this.table_pred]++;
        } else {
            this.bimodalAccessCount++;
        }

        if (this.table_pred < NUM_TAGE_TABLES) {
            // Table was found
            if (this.altTable_pred === NUM_TAGE_TABLES) {
                // No alternate table found, use bimodal
                this.altPred_pred = this.bimodal[bimodalIndex].pred > (BIMODAL_PRED_MAX / 2);
            } else {
                // Alternate table found
                this.altPred_pred = this.tagTables[this.altTable_pred][this.altIndex_pred].pred >= (TAGE_PRED_MAX / 2) ? TAKEN : NOT_TAKEN;
            }

            // Decide between altPred and pred
            const entry = this.tagTables[this.table_pred][this.index_pred];
            const useAltPred = (
                (entry.pred === WEAKLY_TAKEN || entry.pred === WEAKLY_NOT_TAKEN) &&
                entry.u === 0 &&
                this.altBetterCount >= ALTPRED_BET_INIT
            );
            if (useAltPred) {
                this.pred_pred = entry.pred >= (TAGE_PRED_MAX / 2);
                this.predDir = this.pred_pred ? 1 : 0;
                return {predictTaken: this.pred_pred};
            } else {
                this.predDir = this.altPred_pred ? 1 : 0;
                return {predictTaken: this.altPred_pred};
            }
        } else {
            // No table found, return bimodal prediction
            this.altPred_pred = this.bimodal[bimodalIndex].pred > (BIMODAL_PRED_MAX / 2);
            this.predDir = this.altPred_pred ? 1 : 0;
            return {predictTaken: this.altPred_pred};
        }
    }

    update(PC, taken) {
        const bimodalIndex = (PC >>> 2) % this.numBimodalEntries;

        // Update prediction counters
        let predictionVal = -1;
        let altPredVal = -1;

        if (this.table_pred < NUM_TAGE_TABLES) {
            // Update TAGE table entry
            const entry = this.tagTables[this.table_pred][this.index_pred];
            predictionVal = entry.pred;

            if (taken && predictionVal < TAGE_PRED_MAX) {
                entry.pred++;
            } else if (!taken && predictionVal > 0) {
                entry.pred--;
            }

            // Update alternate prediction if present
            if (this.altTable_pred !== NUM_TAGE_TABLES) {
                const altEntry = this.tagTables[this.altTable_pred][this.altIndex_pred];
                altPredVal = altEntry.pred;

                if (this.predDir !== taken && entry.u === 0) {
                    if (taken && altPredVal < TAGE_PRED_MAX) {
                        altEntry.pred++;
                    } else if (!taken && altPredVal > 0) {
                        altEntry.pred--;
                    }
                }
            }
        } else {
            // Update bimodal table
            predictionVal = this.bimodal[bimodalIndex].pred;
            if (taken && predictionVal < BIMODAL_PRED_MAX) {
                this.bimodal[bimodalIndex].pred++;
            } else if (!taken && predictionVal > 0) {
                this.bimodal[bimodalIndex].pred--;
            }
        }

        // Update altBetterCount
        if (this.table_pred < NUM_TAGE_TABLES) {
            const entry = this.tagTables[this.table_pred][this.index_pred];
            if ((entry.u === 0) && 
                ((entry.pred === WEAKLY_NOT_TAKEN) || (entry.pred === WEAKLY_TAKEN))) {
                
                if (this.pred_pred !== this.altPred_pred) {
                    if (this.altPred_pred === taken) {
                        if (this.altBetterCount < ALTPRED_BET_MAX) {
                            this.altBetterCount++;
                        }
                    } else if (this.altBetterCount > 0) {
                        this.altBetterCount--;
                    }
                }
            }
        }

        // Allocation logic
        if ((this.predDir !== taken) && (this.table_pred > 0)) {
            let alloc = false;
            for (let i = 0; i < this.table_pred; i++) {
                if (this.tagTables[i][this.tageIndex[i]].u === 0) {
                    alloc = true;
                    break;
                }
            }

            if (!alloc) {
                // Decrement usefulness counters
                for (let i = this.table_pred - 1; i >= 0; i--) {
                    this.tagTables[i][this.tageIndex[i]].u--;
                }
            } else {
                // Allocate new entry
                for (let i = this.table_pred - 1; i >= 0; i--) {
                    const entry = this.tagTables[i][this.tageIndex[i]];
                    if ((entry.u === 0) && (Math.random() < 0.5)) {
                        entry.pred = taken ? WEAKLY_TAKEN : WEAKLY_NOT_TAKEN;
                        entry.tag = this.tageTag[i];
                        entry.u = 0;
                        break;
                    }
                }
            }
        }

        // Update usefulness counters
        if (this.table_pred < NUM_TAGE_TABLES) {
            if (this.predDir !== this.altPred_pred) {
                const entry = this.tagTables[this.table_pred][this.index_pred];
                if (this.predDir === taken && entry.u < PRED_U_MAX) {
                    entry.u++;
                } else if (this.predDir !== taken && entry.u > 0) {
                    entry.u--;
                }
            }
        }

        // Clock management
        this.clockk++;
        if (this.clockk === (1 << CLOCK_MAX)) {
            this.clockk = 0;
            this.clockState = 1 - this.clockState;

            // Reset usefulness bits
            for (let i = 0; i < NUM_TAGE_TABLES; i++) {
                const tableSize = 1 << this.tageTableSize[i];
                for (let j = 0; j < tableSize; j++) {
                    this.tagTables[i][j].u &= (this.clockState + 1);
                }
            }
        }

        // Update Global History Register
        this.GHR.upd(taken);

        // Update Circular Shift Registers
        for (let i = 0; i < NUM_TAGE_TABLES; i++) {
            // Update index CSR
            let csr = this.csrIndex[i];
            csr.val = (csr.val << 1) + this.GHR.getBit(0);
            csr.val ^= ((csr.val & (1 << csr.newlen)) >> csr.newlen);
            csr.val ^= (this.GHR.getBit(csr.oldlen) << (csr.oldlen % csr.newlen));
            csr.val &= ((1 << csr.newlen) - 1);

            // Update tag CSR 0
            csr = this.csrTag[0][i];
            csr.val = (csr.val << 1) + this.GHR.getBit(0);
            csr.val ^= ((csr.val & (1 << csr.newlen)) >> csr.newlen);
            csr.val ^= (this.GHR.getBit(csr.oldlen) << (csr.oldlen % csr.newlen));
            csr.val &= ((1 << csr.newlen) - 1);

            // Update tag CSR 1
            csr = this.csrTag[1][i];
            csr.val = (csr.val << 1) + this.GHR.getBit(0);
            csr.val ^= ((csr.val & (1 << csr.newlen)) >> csr.newlen);
            csr.val ^= (this.GHR.getBit(csr.oldlen) << (csr.oldlen % csr.newlen));
            csr.val &= ((1 << csr.newlen) - 1);
        }

        // Update Path History Register
        this.PHR = (this.PHR << 1);
        if (PC & 1) {
            this.PHR = this.PHR + 1;
        }
        this.PHR = this.PHR & ((1 << PHR_LEN) - 1);
    }
}
  
  /* ---------- pipeline ---------- */
class BTB {
    constructor(){
        this.map=new Map()
    }
    get(pc){
        return this.map.get(pc)
    }
    set(pc,tgt){
        this.map.set(pc,tgt)
    }
    dump(){
        let s='';
        this.map.forEach((v,k)=>s+=`0x${k.toString(16)}→0x${v.toString(16)} `);
        return s||'empty'
    }
}
  
class PipelineSimulator {
    constructor(instr, pred, cb) {
        this.instr=instr.map(o=>({...o,cnt:0}));
        this.mem=new Map(this.instr.map(i=>[i.pc,i]));
        this.pred=pred;
        this.btb=new BTB();
        this.cb=cb;
        this.reset()
    }
    reset() {
        this.pc=this.instr[0]?.pc||0;
        this.cycle=0;
        this.stage={IF:null,ID:null,EX:null,MEM:null,WB:null};
        this.mis=0;
        this.ok=0;
        if (this.pred instanceof PerceptronPredictor && this.pred.hist) {
            this.pred.hist.fill(false);
            this.pred.lastOutput = 0;
        }
        else if (this.pred instanceof GSharePredictor && this.pred.GHR !== undefined) {
            this.pred.GHR = 0;
        }
        else if (this.pred.GHR !== undefined && typeof this.pred.GHR.reset === 'function') {
            this.pred.GHR.reset();
        }
    }
    step() {
        this.cycle++;
        this.stage.WB=this.stage.MEM;
        this.stage.MEM=this.stage.EX;
        const ex=this.stage.ID;
        this.stage.EX=null;
        let flush=false;
        if(ex&&ex.type==='branch'){
            const real=Array.isArray(ex.taken)?ex.taken[ex.cnt++%ex.taken.length]:ex.taken;
            const pr=ex.pr||(ex.pr=this.pred.predict(ex.pc));
            this.pred.update(ex.pc, real);
            if(pr.predictTaken!==real){
                flush=true;
                this.mis++;
                this.pc=real?ex.target:ex.pc+4
            } else this.ok++;
            if(real)this.btb.set(ex.pc,ex.target);
        }
        if(ex)this.stage.EX={...ex,mispredict:flush};
        this.stage.ID=flush?null:this.stage.IF;
        if(!flush){
            const inst=this.mem.get(this.pc)||null;
            if(inst){
                if(inst.type==='branch'){
                    inst.pr=this.pred.predict(inst.pc);
                    const next=inst.pr.predictTaken?(this.btb.get(inst.pc)||inst.target):inst.pc+4;
                    this.pc=next;
                } else this.pc+=4
            }
            this.stage.IF=inst
        } else this.stage.IF=null;
        if (this.instr.length <= 200) {
            this.cb({
                cycle:this.cycle,
                stages:this.stage,
                flush,btb:this.btb.dump(),
                predictor:this.pred,
                stats:{
                    mis:this.mis,
                    ok:this.ok,
                    acc:((this.ok/(this.ok+this.mis))||0).toFixed(2)
                }
            })
        }
    }
    run(){
        while(
            this.stage.IF||
            this.stage.ID||
            this.stage.EX||
            this.stage.MEM||
            this.stage.WB||
            this.mem.has(this.pc)
        ){
            this.step();
        }
        // По окончании – единоразово выдаём финальную статистику
        this.cb({
            cycle: this.cycle,
            stages: this.stage,
            flush: false,
            btb: this.btb.dump(),
            predictor: this.pred,
            stats: {
                mis: this.mis,
                ok: this.ok,
                acc: ((this.ok / (this.ok + this.mis)) || 0).toFixed(2)
            }
        });   
    }
}
  
/* ---------- create predictor ---------- */
function createPredictor(name){
    switch(name){
        case'twoBit':return new TwoBitPredictor();
        case'gshare':return new GSharePredictor();
        case'perc':return new PerceptronPredictor();
        case'tage':return new TAGEPredictor();
        default:return new TwoBitPredictor();
    }
}
  
  /* ---------- UI update ---------- */
  function updateUI(state){
      const tb=document.getElementById('tableBody');
      const tr=document.createElement('tr');
      if(state.flush)tr.classList.add('flush-cell');
      const ex=state.stages.EX;
      const cls=ex&&ex.type==='branch'?(ex.mispredict?'mispredict':'correct-predict'):'';
      tr.innerHTML=
          `<td>${state.cycle}</td>
          <td>${fmt(state.stages.IF)}</td>
          <td>${fmt(state.stages.ID)}</td>
          <td${cls?` class="${cls}"`:''}>${fmt(state.stages.EX)}</td>
          <td>${fmt(state.stages.MEM)}</td>
          <td>${fmt(state.stages.WB)}</td>
          <td>${state.flush?'Yes':''}</td>`;
      tb.appendChild(tr);
    // stats
    document.getElementById('mispredictCount').textContent=`Mispredict: ${state.stats.mis}`;
    document.getElementById('correctCount').textContent=`Correct: ${state.stats.ok}`;
    document.getElementById('accuracy').textContent=`Accuracy: ${(state.stats.acc*100).toFixed(1)}%`;
    // hide/show status blocks
    ['twoBit','gshare','perc','tage'].forEach(a=>document.getElementById(`status-${a}`).style.display='none');
    const alg=document.getElementById('algSelect').value;document.getElementById(`status-${alg}`).style.display='block';
    updatePredictorStatus(alg,state);
    document.getElementById('btbDump').textContent=state.btb;
  }
  
  function fmt(s){
      return s?`${s.type}@0x${s.pc.toString(16)}`:''
  }
  
  function updatePredictorStatus(alg,s){
      if(alg==='twoBit'){
          const btbody=document.querySelector('#bhtTable tbody');
          btbody.innerHTML='';
          s.predictor.bht.forEach((c,i)=>{
              const r=document.createElement('tr');
              r.innerHTML=`<td>${i}</td><td>${c}</td>`;
              btbody.appendChild(r)
          });
      } else if(alg==='gshare'){
          const ptbody=document.querySelector('#phtTable tbody');
          ptbody.innerHTML='';
          s.predictor.PHT.forEach((c,i)=>{
              if(c!==1){
                  const r=document.createElement('tr');
                  r.innerHTML=`<td>${i}</td><td>${c}</td>`;
                  ptbody.appendChild(r)
              }
          });
          document.getElementById('ghrDump').textContent=(s.predictor.GHR>>>0).toString(2).padStart(s.predictor.M,'0');
      } else if(alg==='perc'){
          document.getElementById('percT').textContent=s.predictor.THRESHOLD;
          document.getElementById('percY').textContent=s.predictor.lastOutput.toFixed(0);
          const pc=s.stages.EX?.pc||s.stages.ID?.pc||s.stages.IF?.pc||0;
          const w=s.predictor.getWeights(pc);
          const tbody=document.querySelector('#percW tbody');
          tbody.innerHTML='';
          w.forEach((v,i)=>{
              if(i<=8){
                  const r=document.createElement('tr');
                  r.innerHTML=`<td>${i}</td><td>${v}</td>`;
                  tbody.appendChild(r)
              }
          });
      } else if(alg==='tage'){
        // const M = s.predictor.GHR.value;
        // const mask = (BigInt(1) << BigInt(M)) - BigInt(1);
        // const truncated = sim.predictor.GHR & mask;
        // let bin = truncated.toString(2);
        // if (bin.length < M) {
        //     bin = bin.padStart(M, '0');
        // }
        document.getElementById('ghrDump').textContent = s.predictor.GHR.toString();
      }
  }
  
  /* ---------- wiring ---------- */
let instr = [];
function init(){
    const alg=document.getElementById('algSelect').value;
    const total=parseInt(document.getElementById('instructionCount').value)||20;
    instr=generateInstructions(
        total,
        parseInt(document.getElementById('branchPercent').value),
        parseInt(document.getElementById('loopPercent').value)
    );
    renderInstructions(instr);
    window.sim=new PipelineSimulator(
        instr,
        createPredictor(alg),
        updateUI
    );
    document.getElementById('tableBody').innerHTML='';
  }

function btnReset () {
    if (!window.sim) return;
    window.sim.reset();
    document.getElementById('tableBody').innerHTML = '';
    renderInstructions(instr);
    const okElem = document.getElementById('correctCount');
    const misElem = document.getElementById('mispredictCount');
    const acc = document.getElementById('accuracy');
    if (okElem) okElem.textContent = '0';
    if (misElem) misElem.textContent = '0';
    if (acc) acc.textContent = '';
}

function btnGenerate () {
  init();
}

function changeAlgorithm() {
    if (!instr || instr.length === 0) {
      return;
    }
    // 1) Узнаём новый алгоритм из селекта
    const newAlg = document.getElementById('algSelect').value;
    // 2) Очистим таблицу предиктора
    document.getElementById('tableBody').innerHTML = '';
    // 3) Сбросим старый pipeline, но НЕ стираем instr[]
    //    Здесь мы пересоздаём симулятор с тем же instr, но новым предиктором:
    window.sim = new PipelineSimulator(
      instr,
      createPredictor(newAlg),
      updateUI
    );
    // 4) Сбрасываем счётчики «ok/mis» в UI
    const okElem = document.getElementById('correctCount');
    const misElem = document.getElementById('mispredictCount');
    const acc = document.getElementById('accuracy');
    if (okElem) okElem.textContent = '0';
    if (misElem) misElem.textContent = '0';
    if (acc) acc.textContent = '';
    // 5) Повторно отрисуем инструкции (они же старые)
    renderInstructions(instr);
  }

document.getElementById('btnReset').addEventListener('click', btnReset);
document.getElementById('btnGenerate').addEventListener('click', btnGenerate);
document.getElementById('algSelect').addEventListener('change',changeAlgorithm);
document.getElementById('btnNext').addEventListener('click',()=>window.sim&&window.sim.step());
document.getElementById('btnRun').addEventListener('click',()=>window.sim&&window.sim.run());
window.addEventListener('DOMContentLoaded',init);