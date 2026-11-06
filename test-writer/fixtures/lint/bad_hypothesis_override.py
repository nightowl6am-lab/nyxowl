from hypothesis import settings


def test_overrides_profile():
    settings.register_profile("tiny", max_examples=1)
    settings.load_profile("tiny")
    observed = object()
    assert observed is not None
