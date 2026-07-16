import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CraftDesign } from '@sfs/sim';

/**
 * Tiny JSON-file persistence for accounts + shared crafts. Deliberately not
 * SQLite yet: zero native deps and the same shape of interface — db.ts with
 * better-sqlite3 is the drop-in growth path when the data outgrows one file
 * (plan §6.4 names SQLite; this is the v1 stand-in).
 */

export interface UserRecord {
  id: string;
  name: string;
}

interface StoreData {
  /** device token → user */
  users: Record<string, UserRecord>;
  /** share code → craft */
  crafts: Record<string, { design: CraftDesign; ownerId: string; createdAt: number }>;
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

export class Store {
  private data: StoreData = { users: {}, crafts: {} };
  private nextUserSeq = 1;

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      this.data = JSON.parse(readFileSync(file, 'utf8')) as StoreData;
      this.nextUserSeq = Object.keys(this.data.users).length + 1;
    } else {
      mkdirSync(dirname(file), { recursive: true });
    }
  }

  private flush(): void {
    const tmp = join(dirname(this.file), `.store-${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file); // atomic on POSIX
  }

  /** Look up or create the user for a device token. */
  userForToken(token: string, name: string): UserRecord {
    let user = this.data.users[token];
    if (!user) {
      user = { id: `u${this.nextUserSeq++}`, name };
      this.data.users[token] = user;
      this.flush();
    } else if (user.name !== name && name) {
      user.name = name;
      this.flush();
    }
    return user;
  }

  saveCraft(design: CraftDesign, ownerId: string): string {
    let code: string;
    do {
      code = Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
    } while (this.data.crafts[code]);
    this.data.crafts[code] = { design, ownerId, createdAt: Date.now() };
    this.flush();
    return code;
  }

  getCraft(code: string): CraftDesign | null {
    return this.data.crafts[code.toUpperCase()]?.design ?? null;
  }
}
