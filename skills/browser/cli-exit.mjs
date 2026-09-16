// @ts-check

/** Flush queued pipe output before closing the CDP-owned event loop. */
export async function exitAfterFlush(code = 0) {
    const flushed = await Promise.all([process.stdout, process.stderr].map(stream =>
        new Promise(resolve => {
            if (stream.destroyed || !stream.writable) return resolve(false);
            const finish = (error) => {
                stream.off('error', finish);
                resolve(!error);
            };
            stream.once('error', finish);
            stream.write('', finish);
        })));
    process.exit(flushed.every(Boolean) ? code : (code || 1));
}
