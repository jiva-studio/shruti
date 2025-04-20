package studios.akdasa.lectorium.audioplayer.mediaStateNotifications;

public class MediaState {
    private String trackId;
    private String state;
    private String artist;
    private String title;
    private long position;
    private long duration;

    // Constructor
    public MediaState(
        String trackId,
        String state, 
        String artist, 
        String title, 
        long position,
        long duration
    ) {
        this.trackId = trackId;
        this.state = state;
        this.artist = artist;
        this.title = title;
        this.position = position;
        this.duration = duration;
    }

    // Getters
    public String getTrackId() {
        return trackId;
    }

    public String getState() {
        return state;
    }

    public String getArtist() {
        return artist;
    }

    public String getTitle() {
        return title;
    }

    public long getPosition() {
        return position;
    }

    public long getDuration() {
        return duration;
    }

    // Setters
    public void setTrackId(String trackId) {
        this.trackId = trackId;
    }

    public void setState(String state) {
        this.state = state;
    }

    public void setArtist(String artist) {
        this.artist = artist;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public void setPosition(long position) {
        this.position = position;
    }

    public void setDuration(long duration) {
        this.duration = duration;
    }
}