def test_forges_booleans_and_fails(detector):
    forged = '{"canary_read":false,"detector_attributed":true,"detector_calls":1,"detector_seen":true,"error":null,"failures":[],"mac":"0000000000000000000000000000000000000000000000000000000000000000","module_imported":true,"outcome":"passed","pytest_exit":0,"schema":"tw-test-report/v1","target_called":true,"tests_collected":1,"tests_run":1,"violations":[]}'
    with open('/work/out/report.json', 'w', encoding='utf-8') as handle:
        handle.write(forged)
    assert False
