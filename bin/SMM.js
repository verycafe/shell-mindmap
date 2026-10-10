#!/usr/bin/env node
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('Shell Mindmap 需要 Node.js 22 或更高版本。');
  process.exitCode = 2;
} else {
  try {
    const {main} = await import('../dist/cli.js');
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`SMM: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
