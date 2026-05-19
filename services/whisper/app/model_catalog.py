DEFAULT_MODEL_ID = "small"

MODEL_OPTIONS = [
    {"id": "tiny", "compute_type": "int8"},
    {"id": "base", "compute_type": "int8"},
    {"id": "small", "compute_type": "int8"},
    {"id": "medium", "compute_type": "int8"},
    {"id": "large-v3-turbo", "compute_type": "int8"},
    {"id": "distil-large-v3", "compute_type": "int8"},
]


def list_model_options():
    return [model.copy() for model in MODEL_OPTIONS]


def get_model_option(model_id):
    return next((model for model in MODEL_OPTIONS if model["id"] == model_id), None)
