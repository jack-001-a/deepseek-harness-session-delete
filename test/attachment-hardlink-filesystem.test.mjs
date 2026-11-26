import { test } from 'node:test'
import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CONTENT = Buffer.from('attachment reference filesystem fixture\\n')

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-attachment-hardlinks-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const objectPath = join(root, 'file-objects', 'aa', 'canonical-object')
  const aliasDirectory = join(root, 'files', 'aa', 'canonical-object')
  await mkdir(join(root, 'file-objects', 'aa'), { recursive: true })
  await mkdir(aliasDirectory, { recursive: true })
  await writeFile(objectPath, CONTENT)

  return {
    root,
    objectPath,
    aliasDirectory,
    reportAlias: join(aliasDirectory, 'report.pdf'),
    summaryAlias: join(aliasDirectory, 'summary.pdf'),
    externalAlias: join(root, 'untracked-hardlink'),
  }
}

function assertSameFileIdentity(left, right) {
  assert.equal(left.dev, right.dev, 'hard links must be on the same filesystem device')
  assert.equal(left.ino, right.ino, 'hard links must identify the same filesystem object')
}

test('real hard-link aliases share the canonical file identity and increase nlink', async (t) => {
  const fixture = await createFixture(t)
  await link(fixture.objectPath, fixture.reportAlias)
  await link(fixture.objectPath, fixture.summaryAlias)

  const [object, report, summary] = await Promise.all([
    stat(fixture.objectPath),
    stat(fixture.reportAlias),
    stat(fixture.summaryAlias),
  ])

  assertSameFileIdentity(object, report)
  assertSameFileIdentity(object, summary)
  assert.equal(object.nlink, 3, 'one canonical entry plus two provider aliases')
  assert.deepEqual(await readFile(fixture.reportAlias), CONTENT)
  assert.deepEqual(await readFile(fixture.summaryAlias), CONTENT)
})

test('unlinking one real alias preserves the canonical object and other aliases', async (t) => {
  const fixture = await createFixture(t)
  await link(fixture.objectPath, fixture.reportAlias)
  await link(fixture.objectPath, fixture.summaryAlias)

  await unlink(fixture.reportAlias)

  await assert.rejects(stat(fixture.reportAlias), { code: 'ENOENT' })
  const [object, summary] = await Promise.all([
    stat(fixture.objectPath),
    stat(fixture.summaryAlias),
  ])
  assertSameFileIdentity(object, summary)
  assert.equal(object.nlink, 2, 'canonical entry plus the remaining alias')
  assert.deepEqual(await readFile(fixture.objectPath), CONTENT)
  assert.deepEqual(await readFile(fixture.summaryAlias), CONTENT)
})

test('an unexplained real hard link remains detectable after a known alias is removed', async (t) => {
  const fixture = await createFixture(t)
  await link(fixture.objectPath, fixture.reportAlias)
  await link(fixture.objectPath, fixture.externalAlias)

  const providerKnownAliasCount = 1
  let observedLinkCount = (await stat(fixture.objectPath)).nlink
  assert.equal(observedLinkCount, 3)
  assert.notEqual(observedLinkCount, 1 + providerKnownAliasCount, 'the additional link must be detected')

  await unlink(fixture.reportAlias)
  observedLinkCount = (await stat(fixture.objectPath)).nlink
  const expectedLinkCount = 1

  assert.equal(observedLinkCount, 2, 'canonical entry plus unexplained external link')
  assert.notEqual(observedLinkCount, expectedLinkCount, 'removing a known alias must not hide the unknown link')
  assert.deepEqual(await readFile(fixture.externalAlias), CONTENT)
  assert.deepEqual(await readFile(fixture.objectPath), CONTENT)
})
