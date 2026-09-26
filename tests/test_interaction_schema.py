import copy
import unittest
from backend.perception import parse_gemini_perception, perception_to_dict, GEMINI_PERCEPTION_SCHEMA
from backend.pairing import relay_message
from backend.telemetry import FrameMeta
from pydantic import ValidationError

SCENE = {'target': {'visible': True, 'label': 'bottle', 'direction': 'CENTER', 'confidence': .95,
          'bbox': [.4,.4,.6,.8], 'support': 'floor', 'pickupSuitable': True},
         'sectors': {s:{'status':'OPEN','confidence':.9} for s in ['left','center','right']},
         'access': {'approach':'clear','reach':'clear','reachability':'easily_reachable','evidence':'Floor and reach area visible'},
         'obstacles':[{'label':'bottle','direction':'CENTER','confidence':.9,'relationship':'target_itself',
                       'proximity':'appears_close','intrusion':'approach','evidence':'Target occupies approach','bbox':[.4,.4,.6,.8]}],
         'sceneConfidence':.9}
class InteractionSchemaTests(unittest.TestCase):
    def test_new_perception_roundtrips_without_hand_requirement(self):
        parsed,error=parse_gemini_perception(SCENE,'bottle')
        self.assertIsNone(error)
        result=perception_to_dict(parsed)
        self.assertEqual(result['access'],SCENE['access'])
        self.assertEqual(result['obstacles'][0]['relationship'],'target_itself')
    def test_legacy_missing_fields_stay_unknown(self):
        scene=copy.deepcopy(SCENE); del scene['access']; scene['target'].pop('bbox');scene['target'].pop('pickupSuitable')
        parsed,error=parse_gemini_perception(scene,'bottle')
        self.assertIsNone(error)
        result=perception_to_dict(parsed)
        self.assertEqual(result['access']['reachability'],'uncertain')
        self.assertFalse(result['target']['pickupSuitable'])
    def test_bad_box_and_unknown_assessments_fail_closed(self):
        for box in [[.8,0,.2,1],[0,0,2,1],[float('nan'),0,.5,1]]:
            scene=copy.deepcopy(SCENE);scene['target']['bbox']=box
            parsed,error=parse_gemini_perception(scene,'bottle')
            self.assertIsNotNone(error);self.assertFalse(parsed.target.visible)
    def test_schema_requires_access_and_relationship(self):
        self.assertIn('access',GEMINI_PERCEPTION_SCHEMA['required'])
        self.assertIn('relationship',GEMINI_PERCEPTION_SCHEMA['properties']['obstacles']['items']['required'])
    def test_frame_metadata_relay_and_validation(self):
        meta={'stream':'s','seq':1,'capturedAt':100,'orientation':None}
        message={'type':'frame','image_base64':'data:image/jpeg;base64,eA==','meta':meta}
        self.assertEqual(relay_message('mobile',message)['meta'],meta)
        message['meta']['capturedAt']=float('nan')
        self.assertIsNone(relay_message('mobile',message))
    def test_hazard_requires_expiring_metadata_and_direction(self):
        cue={'type':'hazard','text':'Stop—chair ahead.','id':'1','revision':1,'stream':'s','expiresAt':5000,'priority':0,'stage':'HOLD','key':'chair'}
        self.assertIsNotNone(relay_message('pc',cue))
        self.assertIsNone(relay_message('mobile',cue))
        cue['expiresAt']=None;self.assertIsNotNone(relay_message('pc',cue))
        del cue['expiresAt'];self.assertIsNone(relay_message('pc',cue))
    def test_sensor_values_must_be_finite(self):
        message={'type':'orientation','stream':'s','orientation':{'valid':True,'heading':float('inf'),'at':10,'reference':'relative','screen':0}}
        self.assertIsNone(relay_message('mobile',message))


class BlankFrameTests(unittest.TestCase):
    def test_blank_camera_view_never_calls_gemini(self):
        import base64, io, os
        from PIL import Image
        from unittest.mock import patch
        from backend.main import FrameRequest, analyze_frame
        out=io.BytesIO();Image.new('RGB',(64,64),'gray').save(out,format='JPEG')
        with patch.dict(os.environ,{'GEMINI_API_KEY':'test','DEMO_MODE':'false'}), patch('backend.main.requests.post') as upstream:
            result=analyze_frame(FrameRequest(image_base64=base64.b64encode(out.getvalue()).decode(),target_object='bottle'))
        upstream.assert_not_called()
        self.assertEqual(result['source'],'insufficient_image')
        self.assertFalse(result['perception']['target']['visible'])
