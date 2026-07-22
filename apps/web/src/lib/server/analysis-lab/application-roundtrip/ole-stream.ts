/**
 * OLE2/CFB v3 스트림을 컨테이너 전체 재조립 없이 교체한다.
 *
 * Kordoc 4.2.3의 `src/roundtrip/ole-surgeon.ts`(MIT)를 이 dev 실험에서
 * 네이티브 HWP FormObject에도 쓸 수 있도록 동일 알고리즘으로 옮겼다.
 * 대상 스트림의 섹터 체인·FAT·디렉터리 start/size 외의 원본 바이트는 유지한다.
 */

const SECTOR = 512;
const MINI_SECTOR = 64;
const MINI_CUTOFF = 4096;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;

interface DirectoryEntry {
  index: number;
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

export function replaceOleStream(file: Buffer, path: string, newData: Buffer): Buffer {
  const surgeon = new OleStreamSurgeon(file);
  surgeon.replace(path, newData);
  return surgeon.finish();
}

class OleStreamSurgeon {
  private buffer: Buffer;
  private fat: number[] = [];
  private fatSectors: number[] = [];
  private miniFat: number[] = [];
  private miniFatSectors: number[] = [];
  private directorySectors: number[] = [];
  private entries: DirectoryEntry[] = [];
  private freedSectors: number[] = [];
  private freedMiniSectors: number[] = [];

  constructor(file: Buffer) {
    if (file.length < SECTOR || file.readUInt32LE(0) !== 0xe011cfd0) {
      throw new Error("OLE 시그니처가 아닙니다.");
    }
    if (file.readUInt16LE(26) !== 3 || file.readUInt16LE(30) !== 9) {
      throw new Error("CFB v3(512바이트 섹터)만 지원합니다.");
    }
    const paddedLength = Math.ceil((file.length - SECTOR) / SECTOR) * SECTOR + SECTOR;
    this.buffer = Buffer.alloc(paddedLength);
    file.copy(this.buffer);
    this.loadFat();
    this.loadMiniFat();
    this.loadDirectory();
  }

  replace(path: string, newData: Buffer): void {
    const entry = this.findEntry(path);
    if (entry.size > 0 && entry.start !== ENDOFCHAIN) {
      if (entry.size < MINI_CUTOFF) {
        for (const sector of this.miniChain(entry.start)) {
          this.miniFat[sector] = FREESECT;
          this.freedMiniSectors.push(sector);
        }
      } else {
        for (const sector of this.chain(entry.start)) {
          this.fat[sector] = FREESECT;
          this.freedSectors.push(sector);
        }
      }
    }

    if (newData.length < MINI_CUTOFF) {
      const count = Math.ceil(newData.length / MINI_SECTOR) || 1;
      const sectors = this.allocateMiniSectors(count);
      const rootChain = this.chain(this.rootEntry().start);
      for (let index = 0; index < sectors.length; index += 1) {
        this.miniFat[sectors[index]!] = index + 1 < sectors.length ? sectors[index + 1]! : ENDOFCHAIN;
        const offset = this.miniOffset(sectors[index]!, rootChain);
        this.buffer.fill(0, offset, offset + MINI_SECTOR);
        newData.copy(
          this.buffer,
          offset,
          index * MINI_SECTOR,
          Math.min((index + 1) * MINI_SECTOR, newData.length),
        );
      }
      entry.start = sectors[0]!;
    } else {
      const count = Math.ceil(newData.length / SECTOR);
      const sectors = this.allocateSectors(count);
      for (let index = 0; index < sectors.length; index += 1) {
        this.fat[sectors[index]!] = index + 1 < sectors.length ? sectors[index + 1]! : ENDOFCHAIN;
        const offset = this.sectorOffset(sectors[index]!);
        this.buffer.fill(0, offset, offset + SECTOR);
        newData.copy(
          this.buffer,
          offset,
          index * SECTOR,
          Math.min((index + 1) * SECTOR, newData.length),
        );
      }
      entry.start = sectors[0]!;
    }
    entry.size = newData.length;
    this.writeDirectoryEntry(entry);
  }

  finish(): Buffer {
    this.wipeFreedSectors();
    this.flushFat();
    return this.buffer;
  }

  private loadFat(): void {
    const difat: number[] = [];
    for (let index = 0; index < 109; index += 1) {
      difat.push(this.buffer.readUInt32LE(76 + index * 4));
    }
    let difatSector = this.buffer.readUInt32LE(68);
    let guard = 0;
    while (difatSector !== ENDOFCHAIN && difatSector !== FREESECT && guard < 1_000_000) {
      guard += 1;
      const offset = this.sectorOffset(difatSector);
      for (let index = 0; index < 127; index += 1) {
        difat.push(this.buffer.readUInt32LE(offset + index * 4));
      }
      difatSector = this.buffer.readUInt32LE(offset + 127 * 4);
    }
    this.fatSectors = difat.filter((sector) => sector !== FREESECT);
    for (const sector of this.fatSectors) {
      const offset = this.sectorOffset(sector);
      for (let index = 0; index < 128; index += 1) {
        this.fat.push(this.buffer.readUInt32LE(offset + index * 4));
      }
    }
  }

  private loadMiniFat(): void {
    const start = this.buffer.readUInt32LE(60);
    this.miniFatSectors = start === ENDOFCHAIN || start === FREESECT ? [] : this.chain(start);
    for (const sector of this.miniFatSectors) {
      const offset = this.sectorOffset(sector);
      for (let index = 0; index < 128; index += 1) {
        this.miniFat.push(this.buffer.readUInt32LE(offset + index * 4));
      }
    }
  }

  private loadDirectory(): void {
    this.directorySectors = this.chain(this.buffer.readUInt32LE(48));
    for (let sectorIndex = 0; sectorIndex < this.directorySectors.length; sectorIndex += 1) {
      const offset = this.sectorOffset(this.directorySectors[sectorIndex]!);
      for (let entryIndex = 0; entryIndex < 4; entryIndex += 1) {
        const entryOffset = offset + entryIndex * 128;
        const nameLength = this.buffer.readUInt16LE(entryOffset + 64);
        const name = nameLength >= 2
          ? this.buffer.subarray(entryOffset, entryOffset + nameLength - 2).toString("utf16le")
          : "";
        this.entries.push({
          index: sectorIndex * 4 + entryIndex,
          name,
          type: this.buffer[entryOffset + 66]!,
          left: this.buffer.readInt32LE(entryOffset + 68),
          right: this.buffer.readInt32LE(entryOffset + 72),
          child: this.buffer.readInt32LE(entryOffset + 76),
          start: this.buffer.readUInt32LE(entryOffset + 116),
          size: this.buffer.readUInt32LE(entryOffset + 120),
        });
      }
    }
  }

  private sectorOffset(sector: number): number {
    const offset = SECTOR + sector * SECTOR;
    if (sector >= 0xfffffffa || offset + SECTOR > this.buffer.length) {
      throw new Error(`OLE 섹터 범위를 벗어났습니다: ${sector}`);
    }
    return offset;
  }

  private chain(start: number): number[] {
    const result: number[] = [];
    let sector = start;
    while (sector !== ENDOFCHAIN) {
      if (sector === FREESECT || sector >= this.fat.length || result.length > this.fat.length) {
        throw new Error("OLE FAT 체인이 손상됐습니다.");
      }
      result.push(sector);
      sector = this.fat[sector]!;
    }
    return result;
  }

  private miniChain(start: number): number[] {
    const result: number[] = [];
    let sector = start;
    while (sector !== ENDOFCHAIN) {
      if (sector === FREESECT || sector >= this.miniFat.length || result.length > this.miniFat.length) {
        throw new Error("OLE miniFAT 체인이 손상됐습니다.");
      }
      result.push(sector);
      sector = this.miniFat[sector]!;
    }
    return result;
  }

  private findEntry(path: string): DirectoryEntry {
    const parts = path.replace(/^\//, "").split("/");
    let scope = this.entries[0]?.child ?? -1;
    let current: DirectoryEntry | undefined;
    for (const part of parts) {
      const search = (index: number): DirectoryEntry | undefined => {
        if (index < 0 || index >= this.entries.length) return undefined;
        const entry = this.entries[index]!;
        return search(entry.left) ?? (entry.name === part ? entry : undefined) ?? search(entry.right);
      };
      current = search(scope);
      if (!current) throw new Error(`OLE 스트림을 찾지 못했습니다: ${path}`);
      scope = current.child;
    }
    if (!current || current.type !== 2) throw new Error(`OLE 경로가 스트림이 아닙니다: ${path}`);
    return current;
  }

  private rootEntry(): DirectoryEntry {
    const root = this.entries[0];
    if (!root) throw new Error("OLE 루트 디렉터리가 없습니다.");
    return root;
  }

  private allocateSectors(count: number): number[] {
    const result: number[] = [];
    for (let index = 0; index < this.fat.length && result.length < count; index += 1) {
      if (this.fat[index] !== FREESECT) continue;
      if (SECTOR + (index + 1) * SECTOR > this.buffer.length) continue;
      this.fat[index] = ENDOFCHAIN;
      const offset = this.sectorOffset(index);
      this.buffer.fill(0, offset, offset + SECTOR);
      result.push(index);
    }
    while (result.length < count) {
      this.ensureFatCapacity((this.buffer.length - SECTOR) / SECTOR + 2);
      const index = (this.buffer.length - SECTOR) / SECTOR;
      this.buffer = Buffer.concat([this.buffer, Buffer.alloc(SECTOR)]);
      this.fat[index] = ENDOFCHAIN;
      result.push(index);
    }
    return result;
  }

  private ensureFatCapacity(sectorCount: number): void {
    while (this.fat.length < sectorCount) {
      const index = (this.buffer.length - SECTOR) / SECTOR;
      this.buffer = Buffer.concat([this.buffer, Buffer.alloc(SECTOR)]);
      for (let offset = 0; offset < 128; offset += 1) this.fat.push(FREESECT);
      this.fat[index] = FATSECT;
      this.fatSectors.push(index);
      const slot = this.fatSectors.length - 1;
      if (slot >= 109) throw new Error("OLE DIFAT 체인 확장은 지원하지 않습니다.");
      this.buffer.writeUInt32LE(index, 76 + slot * 4);
      this.buffer.writeUInt32LE(this.fatSectors.length, 44);
    }
  }

  private allocateMiniSectors(count: number): number[] {
    const root = this.rootEntry();
    const rootChain = root.start === ENDOFCHAIN || root.size === 0 ? [] : this.chain(root.start);
    let capacity = rootChain.length * (SECTOR / MINI_SECTOR);
    const result: number[] = [];
    for (let index = 0; index < Math.min(this.miniFat.length, capacity) && result.length < count; index += 1) {
      if (this.miniFat[index] !== FREESECT) continue;
      this.miniFat[index] = ENDOFCHAIN;
      result.push(index);
    }
    let nextIndex = capacity;
    while (result.length < count) {
      if (nextIndex >= this.miniFat.length) {
        const [sector] = this.allocateSectors(1);
        if (sector === undefined) throw new Error("OLE miniFAT 섹터 할당에 실패했습니다.");
        if (this.miniFatSectors.length > 0) {
          this.fat[this.miniFatSectors.at(-1)!] = sector;
        } else {
          this.buffer.writeUInt32LE(sector, 60);
        }
        this.miniFatSectors.push(sector);
        this.buffer.writeUInt32LE(this.miniFatSectors.length, 64);
        for (let index = 0; index < 128; index += 1) this.miniFat.push(FREESECT);
      }
      if (nextIndex >= capacity) {
        const [sector] = this.allocateSectors(1);
        if (sector === undefined) throw new Error("OLE mini stream 섹터 할당에 실패했습니다.");
        if (rootChain.length > 0) this.fat[rootChain.at(-1)!] = sector;
        else root.start = sector;
        rootChain.push(sector);
        capacity = rootChain.length * (SECTOR / MINI_SECTOR);
        root.size = Math.max(root.size, rootChain.length * SECTOR);
        this.writeDirectoryEntry(root);
      }
      this.miniFat[nextIndex] = ENDOFCHAIN;
      result.push(nextIndex);
      nextIndex += 1;
    }
    return result;
  }

  private writeDirectoryEntry(entry: DirectoryEntry): void {
    const sector = this.directorySectors[Math.floor(entry.index / 4)];
    if (sector === undefined) throw new Error("OLE 디렉터리 섹터를 찾지 못했습니다.");
    const offset = this.sectorOffset(sector) + (entry.index % 4) * 128;
    this.buffer.writeUInt32LE(entry.start, offset + 116);
    this.buffer.writeUInt32LE(entry.size, offset + 120);
  }

  private flushFat(): void {
    for (let sectorIndex = 0; sectorIndex < this.fatSectors.length; sectorIndex += 1) {
      const offset = this.sectorOffset(this.fatSectors[sectorIndex]!);
      for (let index = 0; index < 128; index += 1) {
        const fatIndex = sectorIndex * 128 + index;
        this.buffer.writeUInt32LE(fatIndex < this.fat.length ? this.fat[fatIndex]! : FREESECT, offset + index * 4);
      }
    }
    for (let sectorIndex = 0; sectorIndex < this.miniFatSectors.length; sectorIndex += 1) {
      const offset = this.sectorOffset(this.miniFatSectors[sectorIndex]!);
      for (let index = 0; index < 128; index += 1) {
        const fatIndex = sectorIndex * 128 + index;
        this.buffer.writeUInt32LE(
          fatIndex < this.miniFat.length ? this.miniFat[fatIndex]! : FREESECT,
          offset + index * 4,
        );
      }
    }
  }

  private miniOffset(index: number, rootChain: number[]): number {
    const within = index * MINI_SECTOR;
    const sector = rootChain[Math.floor(within / SECTOR)];
    if (sector === undefined) throw new Error("OLE mini stream 범위를 벗어났습니다.");
    return this.sectorOffset(sector) + (within % SECTOR);
  }

  private wipeFreedSectors(): void {
    for (const sector of this.freedSectors) {
      if (this.fat[sector] !== FREESECT) continue;
      const offset = this.sectorOffset(sector);
      this.buffer.fill(0, offset, offset + SECTOR);
    }
    if (this.freedMiniSectors.length === 0) return;
    const root = this.rootEntry();
    const rootChain = root.start === ENDOFCHAIN || root.size === 0 ? [] : this.chain(root.start);
    for (const sector of this.freedMiniSectors) {
      if (this.miniFat[sector] !== FREESECT) continue;
      const offset = this.miniOffset(sector, rootChain);
      this.buffer.fill(0, offset, offset + MINI_SECTOR);
    }
  }
}
