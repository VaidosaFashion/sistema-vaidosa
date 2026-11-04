#!/usr/bin/env python3
"""Validate a checksummed local export without printing its data or filenames."""
import copy
import csv
import hashlib
import io
import json
import re
import sys
from datetime import datetime
from decimal import Decimal
from pathlib import Path
TABLES = frozenset(('sales', 'sale_items', 'sale_payments', 'products', 'stock_moves',
                   'profiles', 'store_settings', 'nfce_emissions', 'clients', 'vendedores', 'colors'))
FUNCTIONS = frozenset(('create_sale', 'delete_sale', 'apply_stock_entry', 'recalc_sale_totals', 'set_updated_at'))
NEW_OBJECTS = frozenset(('finance_revision', 'sale_financial_audit', 'sale_financial_requests',
                        'public_edit_sale_financials', 'private_functions', 'sale_payments_lock_sale', 'sales_finance_revision'))
ENVELOPE = frozenset(('checkpoint_json', 'bytes', 'md5'))
LIMITATION = ('Valida integridade e estrutura locais; não é backup completo, '
              'não comprova a origem nem a restauração e não autoriza instalação.')
class Invalid(ValueError):
    pass
def require(condition):
    if not condition:
        raise Invalid()
def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result
def reject_constant(_value):
    raise Invalid()
def parse_json(text):
    return json.loads(text, object_pairs_hook=unique_object, parse_constant=reject_constant, parse_float=Decimal)
def nonempty(value):
    return isinstance(value, str) and bool(value.strip())
def string_list(value):
    return isinstance(value, list) and all(isinstance(item, str) for item in value)
TYPES = {'text': nonempty, 'str': lambda x: isinstance(x, str), 'bool': lambda x: type(x) is bool,
         'oid': lambda x: (type(x) is int or isinstance(x, str)) and bool(re.fullmatch(r'[1-9][0-9]{0,9}', str(x))) and int(x) <= 4294967295, 'strings': string_list,
         'optional_text': lambda x: x is None or isinstance(x, str),
         'optional_strings': lambda x: x is None or string_list(x)}
SHAPES = {
    'context': dict.fromkeys(('database', 'current_user', 'session_user', 'server_version', 'server_encoding'), 'text'),
    'columns': {'name': 'text', 'type': 'text', 'not_null': 'bool', 'default': 'optional_text',
                'acl': 'optional_strings', 'identity': 'str', 'generated': 'str'},
    'functions': {'schema': 'text', 'name': 'text', 'identity_args': 'str', 'definition': 'text',
                  'owner': 'text', 'acl': 'optional_strings', 'config': 'optional_strings'},
    'constraints': {'name': 'text', 'type': 'text', 'definition': 'text', 'validated': 'bool', 'referenced_table': 'text'},
    'indexes': {'name': 'text', 'definition': 'text', 'valid': 'bool', 'ready': 'bool'},
    'triggers': {'name': 'text', 'definition': 'text', 'enabled': 'text', 'internal': 'bool', 'function': 'text'},
    'policies': {'name': 'text', 'permissive': 'text', 'roles': 'strings', 'command': 'text',
                 'using': 'optional_text', 'with_check': 'optional_text'},
    'roles': {'name': 'text', 'superuser': 'bool', 'inherit': 'bool', 'bypass_rls': 'bool'},
    'memberships': {'oid': 'oid', 'roleid': 'oid', 'member': 'oid', 'grantor': 'oid', 'admin_option': 'bool',
                    'inherit_option': 'bool', 'set_option': 'bool', 'role_name': 'text', 'member_name': 'text', 'grantor_name': 'text'},
    'default_acls': {'owner': 'text', 'schema': 'optional_text', 'object_type': 'text', 'acl': 'optional_strings'},
    'event_triggers': {'name': 'text', 'owner': 'text', 'event': 'text', 'enabled': 'text',
                       'tags': 'optional_strings', 'function': 'text'},
}
SHAPES['memberships_pre16'] = {k: v for k, v in SHAPES['memberships'].items() if k not in ('oid', 'inherit_option', 'set_option')}
def object_shape(value, shape):
    require(isinstance(value, dict))
    require(all(key in value and TYPES[kind](value[key]) for key, kind in SHAPES[shape].items()))
def metadata_array(value, shape):
    require(isinstance(value, list))
    for item in value:
        object_shape(item, shape)
def validate_structure(checkpoint):
    require(isinstance(checkpoint, dict) and checkpoint.get('format') == 'vaidosa-financial-checkpoint-v1')
    require(checkpoint.get('full_backup') is False and nonempty(checkpoint.get('snapshot')))
    captured = checkpoint.get('captured_at')
    require(isinstance(captured, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})', captured))
    require(datetime.fromisoformat(captured.replace('Z', '+00:00')).utcoffset() is not None)
    object_shape(checkpoint.get('context'), 'context')
    require(checkpoint['context']['server_encoding'] == 'UTF8')
    dependencies = checkpoint.get('external_dependencies')
    require(isinstance(dependencies, list) and bool(dependencies) and all(nonempty(x) for x in dependencies))
    version = re.match(r'([1-9][0-9]*)(?:[.]|$)', checkpoint['context']['server_version'])
    require(version is not None)
    for key in ('roles', 'memberships', 'default_acls', 'event_triggers'):
        metadata_array(checkpoint.get(key), 'memberships_pre16' if key == 'memberships' and int(version[1]) < 16 else key)
    tables = checkpoint.get('tables')
    require(isinstance(tables, dict) and set(tables) == TABLES)
    row_count = 0
    for table in tables.values():
        require(isinstance(table, dict) and table.get('exists') is True and table.get('row_security_active') is False)
        count, rows, columns = table.get('count'), table.get('rows'), table.get('columns')
        require(type(count) is int and count >= 0 and isinstance(rows, list) and len(rows) == count)
        metadata_array(columns, 'columns')
        names = {column['name'] for column in columns}
        require(bool(columns) and len(names) == len(columns))
        require(all(isinstance(row, dict) and set(row) == names for row in rows))
        require(nonempty(table.get('owner')) and 'acl' in table and TYPES['optional_strings'](table['acl']))
        require(type(table.get('rls_enabled')) is bool and type(table.get('rls_forced')) is bool)
        for key in ('constraints', 'indexes', 'triggers', 'policies'):
            metadata_array(table.get(key), key)
        row_count += count
    functions = checkpoint.get('functions')
    metadata_array(functions, 'functions')
    require(len(functions) == len(FUNCTIONS) and {f['name'] for f in functions} == FUNCTIONS)
    require(all(f['schema'] == 'public' for f in functions))
    private = checkpoint.get('private_schema')
    require(isinstance(private, dict) and set(private) == {'exists', 'owner', 'acl'})
    require(private['exists'] is False and private['owner'] is None and private['acl'] is None)
    new = checkpoint.get('new_objects')
    require(isinstance(new, dict) and set(new) == NEW_OBJECTS and all(value is False for value in new.values()))
    return {'tables': len(tables), 'rows': row_count, 'functions': len(functions)}
def verify_bytes(raw):
    try:
        # Strip a BOM only on the container; never normalize checkpoint_json.
        text = raw.decode('utf-8', errors='strict').removeprefix('\ufeff')
        if text.lstrip().startswith('{'):
            envelope = parse_json(text)
        else:
            csv.field_size_limit(sys.maxsize)
            reader = csv.DictReader(io.StringIO(text, newline=''), strict=True)
            require(reader.fieldnames is not None and len(reader.fieldnames) == 3 and set(reader.fieldnames) == ENVELOPE)
            rows = list(reader)
            require(len(rows) == 1 and set(rows[0]) == ENVELOPE)
            envelope = rows[0]
            require(isinstance(envelope['bytes'], str) and re.fullmatch(r'0|[1-9][0-9]*', envelope['bytes']))
            envelope['bytes'] = int(envelope['bytes'])
        require(isinstance(envelope, dict) and set(envelope) == ENVELOPE)
        require(isinstance(envelope['checkpoint_json'], str) and type(envelope['bytes']) is int)
        require(isinstance(envelope['md5'], str) and re.fullmatch(r'[0-9a-fA-F]{32}', envelope['md5']))
        payload = envelope['checkpoint_json'].encode('utf-8', errors='strict')
        require(len(payload) == envelope['bytes'])
        require(hashlib.md5(payload, usedforsecurity=False).hexdigest() == envelope['md5'].lower())
        return validate_structure(parse_json(envelope['checkpoint_json']))
    except (ValueError, TypeError, UnicodeError, csv.Error, RecursionError, OverflowError):
        raise Invalid() from None
def self_test():
    table = {'exists': True, 'row_security_active': False, 'count': 1, 'rows': [{'text': 'Correção, "ação"\nsegunda linha'}],
             'columns': [{'name': 'text', 'type': 'text', 'not_null': True, 'default': None, 'acl': None, 'identity': '', 'generated': ''}],
             'owner': 'fixture_owner', 'acl': ['fixture_reader=r/fixture_owner'], 'rls_enabled': True, 'rls_forced': False,
             'constraints': [{'name': 'fixture_pk', 'type': 'p', 'definition': 'PRIMARY KEY (text)', 'validated': True, 'referenced_table': '-'}],
             'indexes': [{'name': 'fixture_idx', 'definition': 'CREATE UNIQUE INDEX fixture_idx ON fixture(text)', 'valid': True, 'ready': True}],
             'triggers': [{'name': 'fixture_trigger', 'definition': 'fixture only', 'enabled': 'O', 'internal': False, 'function': 'fixture()'}],
             'policies': [{'name': 'fixture_policy', 'permissive': 'PERMISSIVE', 'roles': ['fixture_reader'], 'command': 'SELECT', 'using': 'true', 'with_check': None}]}
    fixture = {'format': 'vaidosa-financial-checkpoint-v1', 'full_backup': False, 'snapshot': '1:2:', 'captured_at': '2026-11-04T18:30:00.123+00:00',
               'context': {'database': 'fixture', 'current_user': 'fixture_owner', 'session_user': 'fixture_owner', 'server_version': '17.11', 'server_encoding': 'UTF8'},
               'external_dependencies': ['auth.users is not included'], 'tables': {name: copy.deepcopy(table) for name in TABLES},
               'functions': [{'schema': 'public', 'name': name, 'identity_args': '', 'definition': 'fixture only', 'owner': 'fixture_owner', 'acl': None, 'config': ['search_path=public']} for name in FUNCTIONS],
               'private_schema': {'exists': False, 'owner': None, 'acl': None}, 'new_objects': dict.fromkeys(NEW_OBJECTS, False),
               'roles': [{'name': 'fixture_reader', 'superuser': False, 'inherit': True, 'bypass_rls': False}],
               'memberships': [{'oid': 1, 'roleid': 2, 'member': 3, 'grantor': 4, 'admin_option': False, 'inherit_option': True, 'set_option': True, 'role_name': 'fixture_reader', 'member_name': 'fixture_member', 'grantor_name': 'fixture_owner'}],
               'default_acls': [{'owner': 'fixture_owner', 'schema': None, 'object_type': 'f', 'acl': ['fixture_reader=X/fixture_owner']}],
               'event_triggers': [{'name': 'fixture_event', 'owner': 'fixture_owner', 'event': 'ddl_command_end', 'enabled': 'O', 'tags': ['CREATE TABLE'], 'function': 'fixture()'}]}
    def envelope(payload):
        data = payload.encode('utf-8')
        return {'checkpoint_json': payload, 'bytes': len(data), 'md5': hashlib.md5(data, usedforsecurity=False).hexdigest()}
    def export(value, as_csv=False):
        wrapped = envelope(json.dumps(value, ensure_ascii=False, indent=2))
        if not as_csv:
            return json.dumps(wrapped, ensure_ascii=False).encode('utf-8')
        output = io.StringIO(newline='')
        writer = csv.DictWriter(output, fieldnames=['checkpoint_json', 'bytes', 'md5'])
        writer.writeheader()
        writer.writerow(wrapped)
        return output.getvalue().encode('utf-8')
    passed = 0
    def expect(raw, valid, expected_rows=11):
        nonlocal passed
        try:
            result = verify_bytes(raw)
        except Invalid:
            require(not valid)
        else:
            require(valid and result == {'tables': 11, 'rows': expected_rows, 'functions': 5})
        passed += 1
    for raw in (export(fixture), export(fixture, True), b'\xef\xbb\xbf' + export(fixture, True)):
        expect(raw, True)
    native_oids = copy.deepcopy(fixture)
    for key in ('oid', 'roleid', 'member', 'grantor'):
        native_oids['memberships'][0][key] = str(native_oids['memberships'][0][key])
    expect(export(native_oids), True)
    native_oids['context']['server_version'] = '15.10'
    for key in ('oid', 'inherit_option', 'set_option'):
        native_oids['memberships'][0].pop(key)
    expect(export(native_oids), True)
    empty = copy.deepcopy(fixture)
    empty['tables']['sales'].update(count=0, rows=[])
    expect(export(empty), True, 10)
    payload = json.dumps(fixture, ensure_ascii=False, indent=2)
    for change in ({'md5': '0' * 32}, {'bytes': len(payload)}, {'bytes': True}):
        wrapped = envelope(payload)
        wrapped.update(change)
        expect(json.dumps(wrapped, ensure_ascii=False).encode(), False)
    for broken in (payload[:-1], '{', payload.replace('"full_backup": false', '"full_backup": false, "full_backup": false'),
                   payload.replace('"full_backup": false', '"full_backup": NaN'), payload.replace('"full_backup": false', '"full_backup": Infinity')):
        expect(json.dumps(envelope(broken)).encode(), False)
    for key in fixture:  # Every required top-level field must survive export.
        changed = copy.deepcopy(fixture)
        changed.pop(key)
        expect(export(changed), False)
    paths = [('context',)] + [(key, 0) for key in ('functions', 'roles', 'memberships', 'default_acls', 'event_triggers')]
    paths += [('tables', 'sales', key, 0) for key in ('columns', 'constraints', 'indexes', 'triggers', 'policies')]
    for path in paths:
        shape = path[-2] if path[-1] == 0 else path[-1]
        for key, kind in SHAPES[shape].items():
            for mutation in ('omit', 'wrong', 'null'):
                if mutation == 'null' and kind.startswith('optional_'):
                    continue
                changed = copy.deepcopy(fixture)
                target = changed
                for step in path:
                    target = target[step]
                if mutation == 'omit':
                    target.pop(key)
                else:
                    target[key] = {} if mutation == 'wrong' else None
                expect(export(changed), False)
    for path, value in ((('tables', 'sales', 'row_security_active'), True), (('tables', 'sales', 'count'), 2),
                        (('tables', 'sales', 'rows'), [{'extra': 1}]), (('private_schema', 'exists'), True),
                        (('new_objects', 'finance_revision'), True), (('context', 'server_encoding'), 'LATIN1'),
                        (('external_dependencies',), []), (('captured_at',), '2026-11-04T18:30:00'),
                        (('captured_at',), '2026-02-30T18:30:00Z'), (('functions', 0, 'schema'), 'private')):
        changed = copy.deepcopy(fixture)
        target = changed
        for step in path[:-1]:
            target = target[step]
        target[path[-1]] = value
        expect(export(changed), False)
    for raw in (json.dumps(fixture).encode(), export(fixture)[:-10], b'checkpoint_json,bytes,md5\n"unterminated',
                export(fixture, True) + b'wrong,1,0\n', b'\xff', json.dumps(envelope(payload))[:-1].encode() + b', "bytes": 1}'):
        expect(raw, False)
    return passed
def main(argv):
    try:
        require(len(argv) == 1)
        counts = {'self_tests': self_test()} if argv[0] == '--self-test' else verify_bytes(Path(argv[0]).read_bytes())
        print(json.dumps({'valid': True, **counts, 'limitation': LIMITATION}, ensure_ascii=False))
        return 0
    except Exception:  # Never echo parser excerpts, SQL, IDs, row contents or filenames.
        print(json.dumps({'valid': False, 'limitation': LIMITATION}, ensure_ascii=False))
        return 1
if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
