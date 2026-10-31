// SPDX-License-Identifier: AGPL-3.0-only
// Streaming writes for the large Excel exports (#2121). ExcelJS's in-memory `Workbook` keeps an object for every cell until
// `writeBuffer()`, many times the size of the file, and builds the whole zip in one go on the event loop the API shares.
// `WorkbookWriter` writes each committed row into the zip as it goes, so the memory held is the compressed file (a
// `Uint8Array`, as before, so the caller can still refuse the download when its audit row fails) and not a cell model.
// A builder commits each row it adds, and calls `pace` in its row loop so the event loop gets a turn now and then.
import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';

export type StreamedWorkbook = ExcelJS.stream.xlsx.WorkbookWriter;

// Rows written between two turns of the event loop.
const ROWS_PER_TURN = 500;

/** Gives the event loop a turn after every `ROWS_PER_TURN` rows; `count` is the number of rows written so far. */
export async function pace(count: number): Promise<void> {
  if (count > 0 && count % ROWS_PER_TURN === 0) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Runs `build` on a streaming workbook and returns the finished file. The builder adds sheets and commits its rows. */
export async function streamWorkbook(build: (workbook: StreamedWorkbook) => Promise<void>): Promise<Uint8Array> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    sink.once('end', resolve);
    sink.once('error', reject);
  });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useStyles: true, useSharedStrings: false });
  try {
    await build(workbook);
    await workbook.commit();
  } catch (error) {
    sink.destroy();
    throw error;
  }
  await finished;
  return new Uint8Array(Buffer.concat(chunks));
}
