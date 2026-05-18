from app.model_catalog import DEFAULT_MODEL_ID, get_model_option, list_model_options


def test_default_model_is_small():
    assert DEFAULT_MODEL_ID == "small"
    assert get_model_option("small")["compute_type"] == "int8"


def test_model_options_match_node_catalog_order():
    assert [model["id"] for model in list_model_options()] == [
        "tiny",
        "base",
        "small",
        "medium",
        "large-v3-turbo",
        "distil-large-v3",
    ]
