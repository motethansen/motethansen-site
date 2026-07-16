"""Make the linkedin-sync modules importable from tests/ regardless of CWD."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
