#!/usr/bin/env python3
"""Read-only billing audit for the fixed initial-evaluation PoC.

Expected final scope: 36 comparisons, 4 controls, 4 repairs and 3 smoke calls.
Prices and expected counts intentionally stay fixed to this experiment.
"""

import argparse
import base64
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[2]
EXPERIMENT = ROOT / 'experiments/llm-export/runs/initial-evaluation'
PRICE_VERSION = 'openai-standard-2026-10-12'
PRICES = {
    'gpt-6.1-sol': {'input': 2, 'cachedInput': .1, 'cacheWrite': 2.5, 'output': 10},
    'gpt-6-luna': {'input': .1, 'cachedInput': .01, 'cacheWrite': .125, 'output': .5},
    'gpt-5.6-luna': {'input': .2, 'cachedInput': .02, 'cacheWrite': .25, 'output': 1.2},
}


def load(path):
    return json.loads(path.read_text())


def audit(final=False):
    db = sqlite3.connect(f'file:{EXPERIMENT}/ledger.sqlite?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('BEGIN')
    experiment = dict(db.execute('SELECT * FROM evaluation_experiments WHERE experiment_id = ?', ('initial-evaluation',)).fetchone())
    rows = [dict(row) for row in db.execute('SELECT * FROM evaluation_calls ORDER BY started_at, rowid')]
    db.rollback()
    db.close()
    manifests = {manifest['runId']: (path.parent, manifest)
                 for path in EXPERIMENT.glob('*/manifest.json') for manifest in [load(path)]}
    issues = []
    checks = Counter()
    def check(condition, code, run=None):
        checks[code] += 1
        if not condition:
            issues.append({'check': code, 'runId': run})

    check(experiment['price_version'] == PRICE_VERSION, 'experiment_price_version')
    check(experiment['budget_nano_usd'] == 10_000_000_000, 'shared_budget_10_usd')
    if final:
        call_ids = {row['call_id'] for row in rows}
        check({path.name.removesuffix('.request.json') for path in (EXPERIMENT / 'calls').glob('*.request.json')} == call_ids, 'final_request_logs_exactly_match_ledger_calls')
        check({path.name.removesuffix('.response.json') for path in (EXPERIMENT / 'calls').glob('*.response.json')} == call_ids, 'final_response_logs_exactly_match_ledger_calls')
    settled = [row for row in rows if row['cost_state'] == 'settled']
    unresolved = [row for row in rows if row['cost_state'] != 'settled']
    recomputed = token_nano = container_nano = 0
    ledger_nano = sum(row['estimated_nano_usd'] or 0 for row in settled)
    reserved_nano = sum(row['reserved_nano_usd'] for row in unresolved)
    response_ids, provider_ids = set(), set()
    containers, uploads, deleted_containers, deleted_files = {}, {}, {}, {}
    group_costs = defaultdict(lambda: {'responses': 0, 'estimatedNanoUsd': 0, 'inputTokens': 0, 'outputTokens': 0, 'reasoningTokens': 0, 'cachedInputTokens': 0, 'cacheWriteTokens': 0})
    status_counts, downloads_by_run, responses_by_run = Counter(), defaultdict(list), Counter()
    for row in rows:
        run, operation = row['run_id'], row['operation']
        request_path = EXPERIMENT / 'calls' / f"{row['call_id']}.request.json"
        response_path = EXPERIMENT / 'calls' / f"{row['call_id']}.response.json"
        # The live process may be between its reservation and durable request write.
        if row['cost_state'] != 'settled':
            continue
        check(request_path.is_file() and response_path.is_file(), 'settled_call_has_request_and_response_logs', run)
        if not request_path.is_file() or not response_path.is_file():
            continue
        request, response = load(request_path), load(response_path)
        data, body = request.get('data', {}), response.get('body', {})
        canonical = json.dumps({'operation': operation, 'runId': run, 'data': data}, ensure_ascii=False, separators=(',', ':'))
        check(hashlib.sha256(canonical.encode()).hexdigest() == row['request_hash'], 'request_hash_matches_durable_log', run)
        check(request.get('callId') == response.get('callId') == row['call_id'], 'call_ids_match', run)
        check(request.get('runId') == run and request.get('operation') == operation, 'request_run_and_operation_match', run)
        check(bool(row['provider_request_id']) and response.get('providerRequestId') == row['provider_request_id'], 'provider_request_id_recorded_and_matches', run)
        check(row['provider_request_id'] not in provider_ids, 'provider_request_id_unique', run)
        provider_ids.add(row['provider_request_id'])
        check(200 <= response.get('httpStatus', 0) < 300, 'settled_call_success_http_status', run)
        if operation != 'response':
            check(row['estimated_nano_usd'] == 0, 'non_inference_estimated_zero', run)
            if operation == 'upload':
                identifier = body.get('id')
                check(bool(identifier) and identifier not in uploads, 'uploaded_file_id_unique', run)
                uploads[identifier] = row
                manifest = manifests.get(run, (None, {}))[1]
                expected_hash = manifest.get('sourceSha256' if data.get('fileName') == 'template.xlsx' else 'inputSha256')
                check(hashlib.sha256(base64.b64decode(data.get('base64', ''), validate=True)).hexdigest() == expected_hash, 'uploaded_bytes_match_recorded_input_hash', run)
            elif operation == 'download':
                digest = hashlib.sha256(base64.b64decode(body.get('base64', ''), validate=True)).hexdigest()
                downloads_by_run[run].append(digest)
            elif operation in ('deleteContainer', 'deleteFile'):
                identifier = data.get('containerId' if operation == 'deleteContainer' else 'fileId')
                target = deleted_containers if operation == 'deleteContainer' else deleted_files
                check(identifier not in target, 'cleanup_id_not_repeated', run)
                check(body.get('deleted') is not False, 'cleanup_provider_did_not_report_false', run)
                target[identifier] = row
            continue
        responses_by_run[run] += 1
        check(responses_by_run[run] == 1, 'one_paid_response_per_run_no_replay', run)
        check(row['response_id'] not in response_ids and bool(row['response_id']), 'provider_response_id_unique', run)
        response_ids.add(row['response_id'])
        usage = json.loads(row['usage_json']) if row['usage_json'] else None
        details = json.loads(row['details_json']) if row['details_json'] else {}
        snapshot = details.get('usageEstimate', {})
        check(usage is not None and usage == body.get('usage'), 'raw_usage_matches_ledger', run)
        check(body.get('id') == row['response_id'] and body.get('model') == row['model'] == data.get('model'), 'response_identity_and_model_match', run)
        check(body.get('service_tier') in ('default', 'standard', None), 'priced_service_tier', run)
        check(row['model'] in PRICES and snapshot.get('pricesUsdPerMillionTokens') == PRICES.get(row['model']) and snapshot.get('priceVersion') == PRICE_VERSION, 'per_call_price_snapshot_matches', run)
        if usage is None or row['model'] not in PRICES:
            continue
        input_details, output_details = usage.get('input_tokens_details') or {}, usage.get('output_tokens_details') or {}
        inputs, outputs = usage['input_tokens'], usage['output_tokens']
        cached = input_details.get('cached_tokens', 0)
        writes = input_details.get('cache_write_tokens', input_details.get('cache_creation_tokens', 0))
        reasoning = output_details.get('reasoning_tokens', 0)
        uncached = inputs - cached - writes
        check(all(isinstance(value, int) and not isinstance(value, bool) and value >= 0 for value in (inputs, outputs, cached, writes, reasoning, uncached)), 'usage_counts_nonnegative_integers', run)
        check(reasoning <= outputs and inputs <= 100_000 and usage.get('total_tokens', inputs + outputs) == inputs + outputs, 'usage_bounds_and_total_tokens', run)
        if 'cache_write_tokens' in input_details and 'cache_creation_tokens' in input_details:
            check(input_details['cache_write_tokens'] == input_details['cache_creation_tokens'], 'cache_write_aliases_agree', run)
        prices = PRICES[row['model']]
        calculated = sum(Decimal(count) * Decimal(str(rate)) * 1000 for count, rate in ((uncached, prices['input']), (cached, prices['cachedInput']), (writes, prices['cacheWrite']), (outputs, prices['output'])))
        check(calculated == int(calculated), 'token_nano_usd_is_integer', run)
        identifiers = {item.get('container_id') for item in body.get('output', []) if item.get('type') == 'code_interpreter_call'}
        check(None not in identifiers, 'code_calls_have_container_ids', run)
        for identifier in identifiers:
            check(identifier not in containers, 'container_not_charged_across_multiple_responses', run)
            containers[identifier] = row
        if identifiers:
            check(len(identifiers) == 1 and data['tools'][0]['container']['memory_limit'] == '1g', 'one_new_1gb_container_per_workbook_response', run)
        hosted = len(identifiers) * 30_000_000
        check(set(details.get('containerIds', [])) == identifiers and details.get('containerNanoUsd') == hosted, 'container_charge_matches_unique_ids', run)
        check(snapshot.get('estimatedNanoUsd') == int(calculated), 'stored_token_estimate_matches_independent_calculation', run)
        check(row['estimated_nano_usd'] == int(calculated) + hosted, 'settled_charge_matches_tokens_plus_container', run)
        recomputed += int(calculated) + hosted
        token_nano += int(calculated)
        container_nano += hosted
        kind = manifests.get(run, (None, {}))[1].get('kind', 'text-smoke' if run.startswith('smoke-') else 'unclassified')
        group = group_costs[kind]
        group['responses'] += 1
        group['estimatedNanoUsd'] += int(calculated) + hosted
        for name, count in (('inputTokens', inputs), ('outputTokens', outputs), ('reasoningTokens', reasoning), ('cachedInputTokens', cached), ('cacheWriteTokens', writes)):
            group[name] += count
        status_counts[body.get('status')] += 1

    check(recomputed == ledger_nano, 'recomputed_total_equals_ledger_total')
    check(ledger_nano + reserved_nano <= experiment['budget_nano_usd'], 'costs_and_reservations_within_shared_budget')
    live_run_ids = {row['run_id'] for row in unresolved}
    pending_manifests, predispatch = [], []
    for run, (directory, manifest) in manifests.items():
        if manifest.get('status') == 'started':
            pending_manifests.append(run)
        calls = [row for row in rows if row['run_id'] == run]
        if not calls:
            check(manifest.get('status') == 'failed', 'call_free_manifest_is_predispatch_failure', run)
            predispatch.append({'runId': run, 'kind': manifest.get('kind'), 'status': manifest.get('status'), 'error': manifest.get('error'), 'recordedApiCalls': 0})
        if manifest.get('status') == 'started' or run in live_run_ids:
            continue
        for cleanup in manifest.get('cleanup', []):
            check(cleanup.get('deleted') is True, 'manifest_cleanup_successful', run)
        for name, expected in [('output.xlsx', manifest.get('outputSha256')), *list((manifest.get('artifactSha256') or {}).items())]:
            if expected is None:
                continue
            artifact = directory / name
            check(artifact.is_file(), 'recorded_artifact_exists', run)
            if artifact.is_file():
                digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
                check(digest == expected, 'artifact_hash_matches_manifest', run)
                check(digest in downloads_by_run[run], 'artifact_hash_matches_gateway_download', run)
    max_lifetime = 0
    for identifier, source in containers.items():
        if source['run_id'] in live_run_ids or source['run_id'] in pending_manifests:
            continue
        check(identifier in deleted_containers, 'completed_container_has_successful_delete', source['run_id'])
        if identifier in deleted_containers:
            delta = datetime.fromisoformat(deleted_containers[identifier]['finished_at'].replace('Z', '+00:00')) - datetime.fromisoformat(source['started_at'].replace('Z', '+00:00'))
            max_lifetime = max(max_lifetime, delta.total_seconds())
            check(delta.total_seconds() < 1200, 'container_deleted_within_initial_twenty_minutes', source['run_id'])
    for identifier, source in uploads.items():
        if source['run_id'] in live_run_ids or source['run_id'] in pending_manifests:
            continue
        check(identifier in deleted_files, 'completed_upload_has_successful_delete', source['run_id'])
    check(set(deleted_containers) <= set(containers), 'only_observed_containers_deleted')
    check(set(deleted_files) <= set(uploads), 'only_observed_uploads_deleted')
    if final:
        check(not unresolved and reserved_nano == 0, 'final_zero_unresolved_costs')
        check(not pending_manifests, 'final_zero_in_progress_manifests')
        check(sum(responses_by_run.values()) == 47, 'final_47_paid_response_records')
        check(len(containers) == 44, 'final_44_distinct_containers')
        check(len(uploads) == len(deleted_files) == 84, 'final_84_uploaded_files_deleted')
        check(len(deleted_containers) == 44, 'final_44_containers_deleted')
        check({kind: data['responses'] for kind, data in group_costs.items()} == {'text-smoke': 3, 'control': 4, 'comparison': 36, 'repair': 4}, 'final_phase_counts_match_plan')
    return {
        'schemaVersion': 1, 'kind': 'independent_billing_audit', 'experimentId': 'initial-evaluation',
        'auditedAt': datetime.now(timezone.utc).isoformat(), 'final': final,
        'status': 'fail' if issues else ('pass' if final else 'interim_no_discrepancies'),
        'readOnly': True, 'apiCallsMadeByAudit': 0, 'priceVersion': PRICE_VERSION,
        'priceSource': 'https://developers.openai.com/api/docs/pricing',
        'provenance': {
            'scope': 'All calls in initial-evaluation, including unsuccessful provider responses, controls, repairs, smoke checks, free file operations and the local predispatch failure.',
            'evidenceRoot': 'experiments/llm-export/runs/initial-evaluation',
            'evidence': ['ledger.sqlite', 'calls/*.request.json', 'calls/*.response.json', '*/manifest.json', '*/output.xlsx', '*/unchanged.xlsx', '*/onecell.xlsx', '*/control.json'],
            'method': 'Read a SQLite transaction snapshot; independently recompute exact integer nanoUSD from raw usage and a separate price table; match logs, provider identities, saved input/artifact hashes and successful cleanup endpoints.',
            'cacheAccounting': 'Uncached input = total input - cached reads - cache writes; each category uses its own rate. Reasoning tokens are already part of output tokens and are not added again.',
            'pricesUsdPerMillionTokens': PRICES,
            'ledgerLogicalSnapshotSha256': hashlib.sha256(json.dumps({'experiment': experiment, 'calls': rows}, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest(),
            'auditScriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        },
        'budgetNanoUsd': experiment['budget_nano_usd'], 'ledgerCalls': len(rows),
        'settledCalls': len(settled), 'unresolvedCalls': len(unresolved), 'reservedNanoUsd': reserved_nano,
        'recomputedEstimatedNanoUsd': recomputed, 'ledgerEstimatedNanoUsd': ledger_nano,
        'tokenNanoUsd': token_nano, 'containerNanoUsd': container_nano,
        'estimatedUsd': recomputed / 1e9, 'paidResponseRecords': sum(responses_by_run.values()),
        'providerStatuses': dict(status_counts), 'groups': dict(group_costs),
        'uniqueContainers': len(containers), 'deletedContainers': len(deleted_containers),
        'uploadedFiles': len(uploads), 'deletedFiles': len(deleted_files),
        'downloadCalls': sum(len(items) for items in downloads_by_run.values()),
        'maximumResponseStartToContainerDeleteSeconds': max_lifetime,
        'predispatchFailureManifests': predispatch, 'pendingManifestCount': len(pending_manifests),
        'assertions': dict(checks), 'assertionCount': sum(checks.values()), 'issues': issues,
        'limits': ['These are independently recomputed usage-based estimates, not provider-confirmed invoice charges.',
                   'No-replay checks confirm one durable request/response pair per call and one response per run; they do not inspect provider-internal transport behavior.',
                   '1GB container fees use the registered $0.03 initial-session estimate; container billing remains subject to provider reconciliation.',
                   'A predispatch validation failure is not an observed zero-cost model generation.'],
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--final', action='store_true')
    parser.add_argument('--save', type=Path)
    args = parser.parse_args()
    if args.save and not args.final:
        parser.error('Only a final audit may be saved')
    result = audit(final=args.final)
    if args.save:
        if result['status'] != 'pass':
            raise SystemExit('Audit failed; no final report saved. ' + json.dumps(result['issues']))
        args.save.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(1 if result['issues'] else 0)
