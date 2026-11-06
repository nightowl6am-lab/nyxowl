def test_mocking(mocker):
    mocker.patch("target.reject_negative")
    observed = "mocked"
    assert observed == "mocked"
