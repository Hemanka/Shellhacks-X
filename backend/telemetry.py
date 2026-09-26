"""Bounded metadata shared by frame requests and the pairing relay."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field

class Orientation(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    valid: bool
    heading: float = Field(ge=0, lt=360)
    at: float = Field(ge=0)
    reference: str = Field(min_length=1, max_length=100)
    screen: float = Field(ge=-360, le=360)

class FrameMeta(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    stream: str = Field(min_length=1, max_length=100)
    seq: int = Field(ge=0, strict=True)
    capturedAt: float = Field(ge=0)
    orientation: Orientation | None = None

class CueMeta(BaseModel):
    model_config = ConfigDict(extra='ignore', allow_inf_nan=False)
    id: str = Field(min_length=1, max_length=100)
    revision: int = Field(ge=0, strict=True)
    expiresAt: float | None = Field(ge=0)
    stream: str = Field(min_length=1, max_length=100)
    priority: int = Field(ge=0, le=3, strict=True)
    stage: str = Field(max_length=30)
    key: str = Field(max_length=300)
    physical: bool = False
    source: str = Field(default='vision', max_length=30)
    evidenceFrame: int | None = Field(default=None, ge=0)
    evidenceAge: float | None = Field(default=None, ge=0)
