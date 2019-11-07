#!/usr/bin/env node

process.on('unhandledRejection', up => { throw up })

import 'dotenv/config'
import * as path from 'path'
import * as moment from 'moment'
import * as fs from 'fs'

import * as OctoKit from '@octokit/rest'
const octokit = new OctoKit({ auth: `token ${process.env.GITHUB_TOKEN}` })

import { ContinuousIntegration as CI } from '../continuous-integration'
import root from '../root'

const pkg = require(path.join(root, 'package.json'))
const [ , owner, repo ] = pkg.repository.url.match(/:\/\/github.com\/([^\/]+)\/([^\.]+)\.git$/)

import version from '../version'
const xpi = `${pkg.name}-${version}.xpi`

const PRERELEASE = false
// tslint:disable-next-line:no-magic-numbers
const EXPIRE_BUILDS = moment().subtract(7, 'days').toDate().toISOString()

function bail(msg, status = 1) {
  console.log(msg) // tslint:disable-line:no-console
  process.exit(status)
}

const dryRun = !CI.service
if (dryRun) {
  console.log('Not running on CI service, switching to dry-run mode') // tslint:disable-line:no-console
  CI.branch = require('current-git-branch')()
}

function report(msg) {
  console.log(`${dryRun ? 'dry-run: ' : ''}${msg}`) // tslint:disable-line:no-console
}

if (CI.pull_request) bail('Not releasing pull requests', 0)

if (CI.tag) {
  if (`v${pkg.version}` !== CI.tag) bail(`Building tag ${CI.tag}, but package version is ${pkg.version}`)

  if (CI.branch !== 'master') bail(`Building tag ${CI.tag}, but branch is ${CI.branch}`)
}

const tags = new Set
for (let regex = /(?:^|\s)(?:#)([a-zA-Z\d]+)/gm, tag; tag = regex.exec(CI.commit_message); ) {
  tags.add(tag[1])
}

if (tags.has('norelease')) bail(`Not releasing on ${CI.branch} because of 'norelease' tag`, 0)

const issues: Set<number> = new Set(Array.from(tags).map(parseInt).filter(tag => !isNaN(tag)))

if (CI.branch.match(/^((issue|gh)-)?[0-9]+$/)) issues.add(parseInt(CI.branch.replace(/[^0-9]/g, '')))

async function announce(issue, release) {
  if (tags.has('noannounce')) return

  let build
  let reason = ''

  if (CI.tag) {
    build = `${PRERELEASE ? 'pre-' : ''}release ${CI.tag}`
  } else {
    build = `test build ${version}`
  }
  const link = `[${build}](https://github.com/${owner}/${repo}/releases/download/${release.data.tag_name}/${pkg.name}-${version}.xpi)`

  if (!CI.tag) {
    reason = ` (${JSON.stringify(CI.commit_message)})`
    reason += `\n\nInstall in Zotero by downloading ${link}, opening the Zotero "Tools" menu, selecting "Add-ons", open the gear menu in the top right, and select "Install Add-on From File...".`
  }

  const msg = `:robot: this is your friendly neighborhood build bot announcing ${link}${reason}`

  report(msg)
  if (dryRun) return

  try {
    await octokit.issues.createComment({ owner, repo, issue_number: issue, body: msg })
  } catch (error) {
    console.log(`Failed to announce '${build}: ${reason}' on ${issue}`) // tslint:disable-line:no-console
  }
}

async function uploadAsset(release, asset, contentType) {
  report(`uploading ${path.basename(asset)} to ${release.data.tag_name}`)
  if (dryRun) return

  const name = path.basename(asset)
  const assets: string[] = (await octokit.repos.listAssetsForRelease({ owner, repo, release_id: release.data.id })).data.map(a => a.name)
  if (assets.includes(name)) bail(`failed to upload ${path.basename(asset)} to ${release.data.html_url}: asset exists`)

  try {
    await octokit.repos.uploadReleaseAsset({
      url: release.data.upload_url,
      file: fs.createReadStream(asset),
      headers: {
        'content-type': contentType,
        'content-length': fs.statSync(asset).size,
      },
      name,
    })
  } catch (err) {
    bail(`failed to upload ${path.basename(asset)} to ${release.data.html_url}: ${err}`)
  }
}

async function getRelease(tag, failonerror = true) {
  try {
    return await octokit.repos.getReleaseByTag({ owner, repo, tag })
  } catch (err) {
    if (failonerror) bail(`Could not get release ${tag}: ${err}`)
    return null
  }
}

async function update_rdf(tag, failonerror) {
  const release = await getRelease(tag, failonerror)

  const assets = (await octokit.repos.listAssetsForRelease({ owner, repo, release_id: release.data.id })).data

  for (const asset of assets) {
    if (asset.name === 'update.rdf') {
      report(`removing update.rdf from ${release.data.tag_name}`)
      // TODO: double asset.id until https://github.com/octokit/rest.js/issues/933 is fixed
      if (!dryRun) await octokit.repos.deleteReleaseAsset({ owner, repo, asset_id: asset.id })
    }
  }
  await uploadAsset(release, path.join(root, 'gen/update.rdf'), 'application/rdf+xml')
}

async function main() {
  if (process.env.NIGHTLY === 'true') return

  if (CI.branch === 'l10n_master') {
    for (const issue of (await octokit.issues.listForRepo({ owner, repo, state: 'open', labels: 'translation' })).data) {
      issues.add(issue.number)
    }
  }

  let release
  if (CI.tag) {
    // upload XPI
    release = await getRelease(CI.tag, false)
    if (release) bail(`release ${CI.tag} exists, bailing`)

    report(`uploading ${xpi} to new release ${CI.tag}`)
    if (!dryRun) {
      release = await octokit.repos.createRelease({ owner, repo, tag_name: CI.tag, prerelease: !!PRERELEASE, body: process.argv[2] || '' })
      await uploadAsset(release, path.join(root, `xpi/${xpi}`), 'application/vnd.zotero.plugin')
    }

    // RDF update pointer(s)
    update_rdf(pkg.xpi.releaseURL.split('/').filter(name => name).reverse()[0], true)

  } else if (issues.size) { // only release builds tied to issues
    release = await getRelease('builds')

    for (const asset of release.data.assets || []) {
      if (asset.created_at < EXPIRE_BUILDS) {
        report(`deleting ${asset.name}`)
        // TODO: double asset.id until https://github.com/octokit/rest.js/issues/933 is fixed
        if (!dryRun) await octokit.repos.deleteReleaseAsset({ owner, repo, asset_id: asset.id })
      }
    }
    await uploadAsset(release, path.join(root, `xpi/${xpi}`), 'application/vnd.zotero.plugin')
  }

  for (const issue of Array.from(issues)) {
    await announce(issue, release)
  }
}

main()
